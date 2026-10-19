// SPDX-License-Identifier: Apache-2.0
// The workspace stores of a Pathrule home, read without opening one for writing: which store
// serves a cwd, and every local workspace there. Kept out of local-backend.ts (a tracked
// hotspot); LocalBackend's static methods delegate here in one line each, and the statements
// are the class's own, moved verbatim with the path helpers the class shares with them.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { pathsEqual, pathStartsWith } from "@pathrule/protocol/path-compare.js";

import { pathruleHome } from "../../storage/paths.js";
import { SET_ASIDE_MARKER } from "../../workspace/local-store-markers.js";
import type { WorkspaceMatch } from "../inputs.js";

type Db = InstanceType<typeof Database>;

/**
 * better-sqlite3's native module did not load: missing, or built for another platform, CPU or
 * Node ABI. Every store would fail the same way, so discovery reports it instead of skipping.
 */
export function isSqliteLoadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ERR_DLOPEN_FAILED") return true;
  // No prebuild for this platform and no local build: the loader's last resort is not there.
  if (code === "MODULE_NOT_FOUND" && err.message.includes("better_sqlite3.node")) return true;
  return /incompatible architecture|invalid ELF header|not a valid Win32 application|Bad EXE format/.test(
    err.message,
  );
}

/** Strip trailing slashes from a path. */
export function normalizePathTail(p: string): string {
  // A drive root (`C:\`) keeps its separator; any other trailing `/` or `\` goes.
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
  return p.replace(/[\\/]+$/, "");
}

/**
 * Canonicalize a workspace root / cwd to its real on-disk path (resolving symlinks),
 * then strip trailing slashes. `pathrule init` and the MCP server can observe the
 * same directory under different symlinked forms (e.g. macOS `/var` → `/private/var`,
 * or a repo reached via a symlink); without canonicalization the longest-prefix match
 * fails and the agent is told "no workspace covers this folder" right after init.
 * Falls back to the trailing-slash-trimmed input if the path can't be resolved
 * (doesn't exist, permission), so a missing/stale dir never throws here.
 */
export function canonicalizePath(p: string): string {
  try {
    // The native realpath also expands Windows 8.3 short names (`RUNNER~1`), so one folder has
    // one canonical form whichever spelling reached us.
    return normalizePathTail(realpathSync.native(p));
  } catch {
    return normalizePathTail(p);
  }
}

/** One local workspace of a Pathrule home (`LocalBackend.listLocalWorkspaces`). */
export interface LocalWorkspaceListing {
  workspaceId: string;
  /** The registered name; the root folder's name when none was registered. */
  name: string;
  /** The folder the workspace is bound to, canonical and without a trailing slash. */
  localRootPath: string;
}

/**
 * Sidecar file marking a store as a mirror of a hosted workspace rather than a workspace of
 * its own. See `markAsMirror` on LocalBackend for why the distinction is load-bearing.
 */
export const MIRROR_MARKER = ".mirror";

/** `LocalBackend.discoverWorkspaceForCwd`: the local workspace store that serves a cwd. */
export function discoverWorkspaceStoreForCwd(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { includeMirrors?: boolean } = {},
): WorkspaceMatch | null {
  const home = pathruleHome(env);
  if (!existsSync(home)) return null;
  const normalizedCwd = canonicalizePath(cwd);

  const candidates: Array<{ wid: string; root: string; mirror: boolean }> = [];
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return null;
  }
  for (const id of entries) {
    const dbPath = join(home, id, "pathrule.db");
    if (!existsSync(dbPath)) continue;
    // A mirror is a local COPY of a hosted workspace, not a workspace. Offering it here
    // makes a caller that asks "is this folder a local workspace?" answer yes for a
    // folder whose authority is the cloud, and then serve a partial copy as the truth.
    // Callers that want the mirror (the offline write path resolving a cwd through the
    // mirror's own registry) ask for it explicitly.
    const mirror = existsSync(join(home, id, MIRROR_MARKER));
    if (mirror && !options.includeMirrors) continue;
    // A store set aside (workspace/local-store-markers.ts) has no certain origin: never a workspace.
    if (existsSync(join(home, id, SET_ASIDE_MARKER))) continue;
    let db: Db | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT id, local_root_path FROM workspaces WHERE local_root_path IS NOT NULL LIMIT 1",
        )
        .get() as { id: string; local_root_path: string } | undefined;
      if (row) {
        candidates.push({ wid: row.id, root: normalizePathTail(row.local_root_path), mirror });
      }
      // An isolated session's cwd is a git worktree, which is NOT under the
      // canonical clone, so discovery has to consider the worktree bindings too.
      // Wrapped separately: a store written before schema v4 has no such table, and
      // that must skip the extra roots rather than skip the whole store.
      try {
        const worktreeRows = db
          .prepare("SELECT workspace_id, local_root_path FROM workspace_worktree_paths")
          .all() as Array<{ workspace_id: string; local_root_path: string }>;
        for (const wt of worktreeRows) {
          candidates.push({
            wid: wt.workspace_id,
            root: normalizePathTail(wt.local_root_path),
            mirror,
          });
        }
      } catch {
        // Pre-v4 store: no worktree bindings to contribute.
      }
    } catch (err) {
      // Skip an unreadable / pre-schema store rather than failing discovery. A SQLite that
      // cannot load is not one store's problem: skipping would report every workspace missing.
      if (isSqliteLoadFailure(err)) throw err;
    } finally {
      db?.close();
    }
  }

  const best = candidates
    .filter((c) => pathsEqual(normalizedCwd, c.root) || pathStartsWith(normalizedCwd, c.root))
    // Longest root wins (the most specific workspace). A real workspace beats a mirror of
    // the same folder: the workspace is the user's own authority, the mirror is a copy of
    // one that lives elsewhere. Only reachable with includeMirrors.
    .sort((a, b) => b.root.length - a.root.length || Number(a.mirror) - Number(b.mirror))[0];
  if (!best) return null;
  // Workspace-relative paths are POSIX (`/src`), whatever separator the platform's cwd uses.
  const rest = normalizedCwd.slice(best.root.length);
  return {
    workspaceId: best.wid,
    localRootPath: best.root,
    relativePath: pathsEqual(normalizedCwd, best.root)
      ? ""
      : process.platform === "win32"
        ? rest.replace(/\\/g, "/")
        : rest,
  };
}

/** `LocalBackend.listLocalWorkspaces`: every local workspace of a Pathrule home, no mirrors. */
export function listLocalWorkspaceStores(
  env: NodeJS.ProcessEnv = process.env,
): LocalWorkspaceListing[] {
  const home = pathruleHome(env);
  if (!existsSync(home)) return [];
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }
  const listed: LocalWorkspaceListing[] = [];
  const seen = new Set<string>();
  for (const id of entries) {
    const dbPath = join(home, id, "pathrule.db");
    if (!existsSync(dbPath)) continue;
    if (existsSync(join(home, id, MIRROR_MARKER)) || existsSync(join(home, id, SET_ASIDE_MARKER))) continue;
    let db: Db | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT id, name, local_root_path FROM workspaces WHERE local_root_path IS NOT NULL LIMIT 1",
        )
        .get() as { id: string; name: string | null; local_root_path: string } | undefined;
      if (row && !seen.has(row.id)) {
        seen.add(row.id);
        const localRootPath = normalizePathTail(row.local_root_path);
        const stored = row.name?.trim() ?? "";
        listed.push({
          workspaceId: row.id,
          // `registerWorkspace` stores the id when no name was given; the folder reads better.
          name:
            stored && stored !== row.id
              ? stored
              : localRootPath.split(/[\\/]/).filter(Boolean).pop() || row.id,
          localRootPath,
        });
      }
    } catch (err) {
      // Skip an unreadable / pre-schema store rather than failing the listing.
      if (isSqliteLoadFailure(err)) throw err;
    } finally {
      db?.close();
    }
  }
  return listed.sort(
    (a, b) => a.name.localeCompare(b.name) || a.localRootPath.localeCompare(b.localRootPath),
  );
}
