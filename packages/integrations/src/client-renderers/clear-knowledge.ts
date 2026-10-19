// SPDX-License-Identifier: Apache-2.0
// Take what Pathrule wrote for agents out of a folder no workspace of it serves any more.
//
// Used when a Pathrule Cloud workspace stops serving a folder: `pathrule detach`, and the move to Pathrule
// Local (`setup --local`, before the Local render writes what Local needs). Nothing a Cloud render, or an
// older Pathrule, put where an agent reads instructions may stay: no rules file, no knowledge file, no
// protocol region in the person's AGENTS.md or CLAUDE.md. Only what is provably Pathrule's goes, decided
// once for every cleanup (core paths/region.ts `pathruleShare`):
//   - a file Pathrule wrote as a whole: removed;
//   - Pathrule's anchored region in a file of the person's: taken out, every other byte as they had it;
//   - a marker whose region cannot be told apart from their text: left as it is, and reported;
//   - a file with no Pathrule marker: never touched.
// The files are found through the ledger AND a bounded walk of the agent instruction names, so one the
// ledger missed is not left behind. Hook entries stay: they deliver nothing for a folder with no
// workspace, and the person's settings are theirs (eject removes them).
//
// Node-only. Never throws. A second run changes nothing.

import { readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isPathruleManaged } from "@pathrule/core/paths/ownership.js";
import { pathruleShare } from "@pathrule/core/paths/region.js";
import {
  forgetManagedFileOwnership,
  readManagedFileOwnershipManifest,
} from "@pathrule/core/storage/managed-file-ownership.js";

import { isPathruleOwnedName, walkCandidates } from "../eject.js";

/** Claude Code's rules folder (claude-knowledge-renderer.ts). */
const RULES_DIR = ".claude/rules/pathrule";

/** The protocol files clients read at a folder's root, checked whatever the ledger says. */
export const PROTOCOL_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".github/copilot-instructions.md",
  ".cursor/rules/pathrule-protocol.mdc",
  ".windsurf/rules/pathrule-protocol.md",
] as const;

/** Hook configs: the person's settings, which a detach leaves (eject takes Pathrule's entries out). */
const HOOK_CONFIGS = new Set([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".github/hooks/pathrule.json",
]);

export interface ClearedKnowledge {
  /** Files removed: nothing of the person's was in them. */
  removed: number;
  /** Files of the person's that had only Pathrule's region taken out. */
  stripped: number;
  /** Files that carry a Pathrule marker where its text cannot be told apart: left as they are. */
  unclear: Array<{ path: string; reason: string }>;
  errors: string[];
}

export async function clearRenderedKnowledge(root: string): Promise<ClearedKnowledge> {
  const out: ClearedKnowledge = { removed: 0, stripped: 0, unclear: [], errors: [] };
  const read = (path: string) => readFile(join(root, path), "utf8").catch(() => null);
  const ledger = (await readManagedFileOwnershipManifest(root).catch(() => ({ files: [] }))).files.map((f) => f.path);
  try {
    const rules = (await readdir(join(root, RULES_DIR), { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isFile())
      .map((d) => `${RULES_DIR}/${d.name}`);
    const walked = await walkCandidates(root).catch(() => [] as string[]);
    const candidates = new Set([...rules, ...ledger, ...walked, ...PROTOCOL_FILES]);
    for (const path of candidates) {
      if (path === ".pathrule" || path.startsWith(".pathrule/") || HOOK_CONFIGS.has(path)) continue;
      if (path.split("/").pop() === ".gitignore" && !path.startsWith(`${RULES_DIR}/`)) continue;
      const body = await read(path);
      if (body === null) continue;
      try {
        if (path.startsWith(`${RULES_DIR}/`)) {
          // The folder's own files carry a marker, its ignore file a header no marker matches.
          if (isPathruleManaged(body) || body.startsWith("# Pathrule managed")) {
            await unlink(join(root, path));
            out.removed += 1;
          }
          continue;
        }
        // A name only Pathrule writes is its own whatever is inside (the protocol copy carries no banner).
        const share = isPathruleOwnedName(path) ? { kind: "whole" as const } : pathruleShare(path, body);
        if (share.kind === "none") continue;
        if (share.kind === "ambiguous") {
          out.unclear.push({ path, reason: share.reason });
          continue;
        }
        if (share.kind === "region") {
          await writeFile(join(root, path), share.rest, "utf8");
          out.stripped += 1;
        } else {
          await unlink(join(root, path));
          out.removed += 1;
        }
      } catch (err) {
        out.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Only once empty: a file of the person's in it stays, and so does the folder.
    await rmdir(join(root, RULES_DIR)).catch(() => undefined);
    // The ledger forgets what it recorded that is gone or no longer Pathrule's.
    const forgotten: string[] = [];
    for (const path of ledger) {
      if (HOOK_CONFIGS.has(path)) continue;
      const body = await read(path);
      if (body === null || !isPathruleManaged(body)) forgotten.push(path);
    }
    await forgetManagedFileOwnership({ workspaceRoot: root, paths: forgotten }).catch((err: unknown) => {
      out.errors.push(`.pathrule/managed-files.json: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}
