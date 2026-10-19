// SPDX-License-Identifier: Apache-2.0
//
// Well-known Pathrule locations inside a user's workspace. Single source of
// truth so every writer (desktop, CLI, MCP server) agrees, and so a path can
// never drift between two code paths the way the backup location once did.
//
// Pure strings, no I/O, so any package can import this.

/** Machine-local Pathrule state, gitignored as a whole. */
export const PATHRULE_DIR = ".pathrule";

/**
 * Where a user's pre-existing file goes when Pathrule takes over its filename.
 *
 * The original relative path is preserved beneath this directory, e.g.
 * `packages/api/CLAUDE.md` → `.pathrule/backups/packages/api/CLAUDE.md`.
 * That keeps two same-named files in different packages from colliding, keeps a
 * dotfile's real name intact, makes restoring a straight copy back, and keeps
 * the working tree free of stray `backup.*` files.
 */
export const BACKUP_DIR = `${PATHRULE_DIR}/backups`;

/** The managed-file ownership ledger. */
export const MANAGED_FILES_LEDGER = `${PATHRULE_DIR}/managed-files.json`;

/** Workspace-relative backup location for a workspace-relative source path. */
export function backupRelativePath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${BACKUP_DIR}/${clean}`;
}
