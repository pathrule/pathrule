// SPDX-License-Identifier: Apache-2.0
//
// Recovery for repos that were synced by an OLDER Pathrule, back when it took a
// user's instruction file over instead of merging a region into it.
//
// Those repos carry leftovers the new writers never produce:
//   - `backup.CLAUDE.md`, `backup.AGENTS.md`, `backup..cursorrules` (the double
//     dot came from prefixing an already-dotted filename) next to the original;
//   - `.pathrule/backups/<path>` entries from the interim vault layout;
//   - a live instruction file that is entirely Pathrule's, while the user's real
//     content sits in one of the above.
//
// The contract here is deliberately conservative: this module only REPORTS. It
// never restores automatically. A user may have deliberately abandoned that old
// file, and silently reviving it would be a second surprise on top of the first.
// The desktop turns a plan into an offer; the user decides per item.
//
// Pure and dependency-free: callers supply the file listing and contents, which
// keeps this testable and usable from desktop, CLI, and MCP alike.

import { opensWithPathruleBanner } from "./ownership.js";
import { hasRegion, stripRegion } from "./region.js";
import { BACKUP_DIR } from "./workspace-files.js";

/** Instruction filenames a client dictates, which a user may own. */
const INSTRUCTION_BASENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "copilot-instructions.md",
]);

/** One file on disk, as the caller found it. */
export interface ScannedFile {
  /** Workspace-relative, forward slashes, no leading slash. */
  path: string;
  content: string;
}

export type LeftoverKind =
  /** `backup.<name>` (or `backup..<name>`) sitting next to the original. */
  | "stray_backup"
  /** An entry under `.pathrule/backups/`. */
  | "vault_backup";

export interface Leftover {
  kind: LeftoverKind;
  /** Where the leftover lives now. */
  path: string;
  /** The instruction file it was taken from, if that can be determined. */
  restoresTo: string | null;
  /**
   * True when the live file at `restoresTo` currently holds NO user content, so
   * restoring is purely additive. False when the user already has content there
   * and a merge decision is needed.
   */
  liveFileIsPathruleOnly: boolean;
  /**
   * True when the BACKUP itself holds user content. False means Pathrule backed
   * up its own output, so there is nothing to recover and restoring it would
   * write stale Pathrule bytes into the user's file as if they were the user's.
   * Such a leftover is offered for deletion, never for restore.
   */
  carriesUserContent: boolean;
  /** First line of the backup, to show the user what it is. */
  preview: string;
}

export interface RecoveryPlan {
  leftovers: Leftover[];
  /** Live instruction files that are entirely Pathrule's with a backup available. */
  restorable: Leftover[];
  /** Leftovers whose live file already has user content: needs a human choice. */
  needsChoice: Leftover[];
  /**
   * Leftovers that are Pathrule's own output. Nothing to recover: the only
   * sensible offer is to delete them. Kept as its own bucket rather than folded
   * into `restorable` so a UI cannot present junk as the user's lost work.
   */
  discardable: Leftover[];
}

/** "packages/api/backup.CLAUDE.md" → "packages/api/CLAUDE.md" */
function strayBackupTarget(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);

  // Numbered collisions: backup.CLAUDE.md.3
  const withoutSuffix = base.replace(/\.\d+$/, "");
  if (!withoutSuffix.startsWith("backup.")) return null;

  // `backup.` + name, or the malformed `backup.` + `.dotfile` → `backup..dotfile`
  const remainder = withoutSuffix.slice("backup.".length);
  const candidate = remainder.startsWith(".") ? remainder : remainder;
  if (!INSTRUCTION_BASENAMES.has(candidate)) return null;
  return `${dir}${candidate}`;
}

/** ".pathrule/backups/packages/api/CLAUDE.md" → "packages/api/CLAUDE.md" */
function vaultBackupTarget(path: string): string | null {
  const prefix = `${BACKUP_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const inner = path.slice(prefix.length).replace(/\.\d+$/, "");
  const base = inner.slice(inner.lastIndexOf("/") + 1);
  return INSTRUCTION_BASENAMES.has(base) ? inner : null;
}

/**
 * True when this body holds nothing of the USER's: it is entirely Pathrule's
 * output, or a shell whose only content is a Pathrule region.
 *
 * One predicate for two questions that used to be asked differently. Applied to
 * the LIVE file it answers "is restoring purely additive". Applied to the BACKUP
 * it answers "is there anything here worth restoring at all", and skipping that
 * second use is how seven byte-identical copies of Pathrule's own output came to
 * be offered as the user's lost work.
 */
function holdsNoUserContent(content: string | undefined): boolean {
  if (content === undefined) return true;
  if (hasRegion(content)) return stripRegion(content).trim() === "";
  // A body that only quotes a banner holds the person's text: restorable, never discarded.
  return opensWithPathruleBanner(content);
}

function firstMeaningfulLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("<!--")) continue;
    return trimmed.slice(0, 120);
  }
  return "";
}

/**
 * Build a recovery plan from a scan of the workspace.
 *
 * Callers pass every file they are willing to consider; this picks out the
 * leftovers and works out whether each one can be restored cleanly.
 */
export function buildRecoveryPlan(files: readonly ScannedFile[]): RecoveryPlan {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const leftovers: Leftover[] = [];

  for (const file of files) {
    const strayTarget = strayBackupTarget(file.path);
    const vaultTarget = strayTarget === null ? vaultBackupTarget(file.path) : null;
    if (strayTarget === null && vaultTarget === null) continue;

    const restoresTo = strayTarget ?? vaultTarget;
    const live = restoresTo === null ? undefined : byPath.get(restoresTo);

    // No live file at all, or a live file that holds nothing of the user's.
    const liveFileIsPathruleOnly = holdsNoUserContent(live);

    leftovers.push({
      kind: strayTarget !== null ? "stray_backup" : "vault_backup",
      path: file.path,
      restoresTo,
      liveFileIsPathruleOnly,
      carriesUserContent: !holdsNoUserContent(file.content),
      preview: firstMeaningfulLine(file.content),
    });
  }

  leftovers.sort((a, b) => a.path.localeCompare(b.path));
  return {
    leftovers,
    restorable: leftovers.filter((l) => l.carriesUserContent && l.liveFileIsPathruleOnly),
    needsChoice: leftovers.filter((l) => l.carriesUserContent && !l.liveFileIsPathruleOnly),
    discardable: leftovers.filter((l) => !l.carriesUserContent),
  };
}

/**
 * The bytes to write when restoring one leftover, or null when the caller must
 * ask the user first.
 *
 * Restoring never discards Pathrule's region: the user's recovered content goes
 * back, and the region is re-merged on the next sync. When the live file already
 * has user content, this returns null rather than guessing at a merge.
 */
export function restoredBody(leftover: Leftover, backupContent: string): string | null {
  // Belt and braces: the plan already keeps these out of `restorable`, but a
  // caller holding a stale plan must not be able to write Pathrule's own old
  // bytes back into the user's file.
  if (!leftover.carriesUserContent) return null;
  if (!leftover.liveFileIsPathruleOnly) return null;
  const body = backupContent.replace(/\n+$/, "");
  return body === "" ? "" : `${body}\n`;
}
