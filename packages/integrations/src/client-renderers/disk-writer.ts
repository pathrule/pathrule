// SPDX-License-Identifier: Apache-2.0
// Node-only disk writer for the multi-client renderer pipeline. Writes
// every emitted file atomically (tmp + rename) and sweeps orphans the
// renderer used to own but no longer emits. Both the CLI
// and the MCP server import this directly — DO NOT re-export from the
// shared barrel (sandboxed preload + renderer would crash).

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { pathruleShare } from "@pathrule/core/paths/region.js";

import type { ClientRenderResult } from "./orchestrator.js";
import { prepareSafeWrite } from "./safe-write.js";
import {
  forgetManagedFileOwnership,
  recordManagedFileOwnership,
  type ManagedFileOwner,
} from "@pathrule/core/storage/managed-file-ownership.js";

async function atomicWrite(target: string, body: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, target);
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function unlinkIfExists(p: string): Promise<boolean> {
  try {
    await unlink(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

export interface DiskWriteOptions {
  /** Workspace root absolute path. */
  workspaceRoot: string;
  /** Output of `renderForClients` — typically per-client. */
  results: ClientRenderResult[];
  /** All clients we sweep orphans for. Pass the full ENABLED set; clients
   *  that are no longer enabled should be cleaned up via their dedicated
   *  uninstall flow (see `ai-client-uninstall.ts`). */
  sweepFor: readonly string[];
  /** Runtime that initiated the write. Used for cross-surface coexistence diagnostics. */
  runtimeOwner?: ManagedFileOwner;
  runtimeVersion?: string;
  /**
   * Orphan-sweep toggle (default true). Set false for an INCREMENTAL render
   * where `results` intentionally covers only a subset of the
   * owned files — sweeping would delete every directory file the partial run
   * didn't emit. With sweep off, the writer only adds/updates the emitted
   * files and removes nothing; orphan cleanup defers to the next full sync.
   */
  sweep?: boolean;
}

export interface DiskWriteResult {
  written: number;
  skipped: number;
  removed: number;
  /** Paths Pathrule renamed before overwriting user-canonical files
   *  (e.g. `.cursorrules` → `backup.cursorrules`). Surfaced to the UI so the
   *  user can recover their original content if needed. */
  backedUp: string[];
  /** Workspace-relative paths this run wrote, retracted a region from, or removed. */
  changed: string[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * For each enabled client, compare desired files against disk:
 *   - file desired but missing or content-changed → write
 *   - file desired and on-disk content matches    → skip
 *   - path was owned previously (in `ownedPaths`) but no longer emitted
 *     by the renderer → unlink
 *
 * Idempotent: re-running with the same input is a sequence of skips.
 */
export async function writeMultiClientFiles(opts: DiskWriteOptions): Promise<DiskWriteResult> {
  const result: DiskWriteResult = {
    written: 0,
    skipped: 0,
    removed: 0,
    backedUp: [],
    changed: [],
    errors: [],
  };
  const ownedThisRun = new Set<string>();
  const removedThisRun = new Set<string>();

  for (const r of opts.results) {
    const desiredPaths = new Set(r.files.map((f) => f.path));

    for (const file of r.files) {
      const abs = join(opts.workspaceRoot, file.path);
      try {
        const current = await readIfExists(abs);
        const decision = await prepareSafeWrite({
          workspaceRoot: opts.workspaceRoot,
          relativePath: file.path,
          renderedBody: file.body,
          existingBody: current,
        });
        if (decision.backupPath) result.backedUp.push(decision.backupPath);
        if (decision.finalBody === null) {
          result.skipped += 1;
          ownedThisRun.add(file.path);
          continue;
        }
        await atomicWrite(abs, decision.finalBody);
        result.written += 1;
        result.changed.push(file.path);
        ownedThisRun.add(file.path);
      } catch (err) {
        result.errors.push({
          path: file.path,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Sweep orphans: paths the renderer claims to own that aren't part of
    // this run's emission. Caller is responsible for not racing two
    // renderers against the same client (we only write/sweep within `r`).
    // Safety: never delete a file that does not carry a Pathrule marker —
    // owned-path supersets (e.g. per-directory knowledge files) may collide
    // with user-authored files of the same canonical name.
    // Skipped entirely for incremental renders (sweep === false): `results`
    // covers only a subset, so r.ownedPaths (the full overview-derived superset)
    // would otherwise delete every file this partial run didn't emit.
    if (opts.sweep === false) continue;
    for (const owned of r.ownedPaths) {
      if (desiredPaths.has(owned)) continue;
      const abs = join(opts.workspaceRoot, owned);
      const current = await readIfExists(abs);
      if (current === null) continue;

      // What of it is Pathrule's, decided once for every cleanup (core paths/region.ts): a file of the
      // person's keeps every byte outside the region, and one whose region cannot be told apart from
      // their text is left exactly as it is and reported.
      const share = pathruleShare(owned, current);
      if (share.kind === "none") continue;
      if (share.kind === "ambiguous") {
        result.errors.push({ path: owned, message: `left as it is: ${share.reason}` });
        continue;
      }
      if (share.kind === "region") {
        try {
          await atomicWrite(abs, share.rest);
          result.written += 1;
          result.changed.push(owned);
        } catch (err) {
          result.errors.push({
            path: owned,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        removedThisRun.add(owned); // no longer a Pathrule-owned file
        continue;
      }

      const removed = await unlinkIfExists(abs);
      if (removed) {
        result.removed += 1;
        result.changed.push(owned);
        removedThisRun.add(owned);
      }
    }
  }

  if (opts.runtimeOwner && opts.runtimeVersion) {
    try {
      await recordManagedFileOwnership({
        workspaceRoot: opts.workspaceRoot,
        paths: Array.from(ownedThisRun),
        owner: opts.runtimeOwner,
        ownerVersion: opts.runtimeVersion,
      });
      await forgetManagedFileOwnership({
        workspaceRoot: opts.workspaceRoot,
        paths: Array.from(removedThisRun),
      });
    } catch (err) {
      result.errors.push({
        path: ".pathrule/managed-files.json",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
