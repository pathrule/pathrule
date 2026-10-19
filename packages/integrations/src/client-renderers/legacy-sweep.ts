// SPDX-License-Identifier: Apache-2.0
// One-time cleanup of what an OLDER Pathrule left in a repo.
//
// Expecting existing users to run `pathrule eject` to clean up after us is not a
// migration, it is a chore we invented and handed to them. So everything that is
// PROVABLY ours goes automatically, and only the cases that need a human
// decision wait for one.
//
// The whole safety argument is one predicate. `planRecovery` classifies every
// leftover by whether it CARRIES USER CONTENT (see paths/recovery.ts): a backup
// that is byte-for-byte Pathrule's own output holds nothing to recover, and
// restoring it would write our stale bytes into the user's file as if they were
// theirs. Measured across two real repos: 7 of 8 leftovers were ours (seven
// identical copies of one file, all committed to git), 1 was the user's. This
// removes the seven and reports the one.
//
// Cost: `planRecovery` walks the tree, measured at 139 ms on this repo and 315 ms
// on a large one. A migration only has to happen once, and nothing in the current
// Pathrule creates these files any more, so it runs once per workspace per
// process rather than on every sync.

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { isPathruleManaged } from "@pathrule/core/paths/ownership.js";
import { planRecovery } from "./recovery-scan.js";

/**
 * Files Pathrule wrote under a name of its own invention, that NO current
 * renderer emits or claims in `ownedPaths`.
 *
 * The disk-writer sweep only deletes paths a renderer still owns, so a path we
 * stopped writing is invisible to it and stays in the user's repo forever,
 * drifting further from the truth with every release. `.claude/rules/pathrule-protocol.md`
 * hit exactly this and needed its own bespoke remover; these are the same class.
 *
 * Found on a real checkout 2026-09-01: both files present and untracked, no
 * writer for either anywhere in the codebase.
 *
 * Safe to delete by construction — the `pathrule-` filename is ours, it can hold
 * no user content — but the marker is still checked before unlinking, because
 * "we are sure this is ours" is exactly the reasoning that deletes someone's
 * file when it turns out to be wrong.
 */
const ORPHANED_PATHRULE_FILES = [
  ".agents/rules/pathrule-protocol.md",
  ".agents/rules/pathrule-knowledge.md",
] as const;

async function removeOrphanedPathruleFiles(rootPath: string): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of ORPHANED_PATHRULE_FILES) {
    const abs = join(rootPath, rel);
    try {
      const body = await readFile(abs, "utf8");
      if (!isPathruleManaged(body)) continue; // not ours after all — leave it
      await unlink(abs);
      removed.push(rel);
    } catch {
      // Absent, or unreadable. Both mean nothing to do.
    }
  }
  return removed;
}

export interface LegacySweepResult {
  /** Leftovers removed: Pathrule's own output, nothing of the user's inside. */
  removed: string[];
  /**
   * Leftovers left alone because they hold the USER's content. Reported rather
   * than touched: reviving a file they may have deliberately abandoned, or
   * picking a merge for them, is not ours to decide. The surface prompts.
   */
  held: string[];
  /** False when the sweep had already run for this root in this process. */
  ran: boolean;
}

const SWEPT = new Set<string>();

/** Test seam: forget which roots have been swept. */
export function __resetLegacySweepForTests(): void {
  SWEPT.clear();
}

export async function sweepPathruleOwnLeftovers(rootPath: string): Promise<LegacySweepResult> {
  if (SWEPT.has(rootPath)) return { removed: [], held: [], ran: false };
  SWEPT.add(rootPath);

  let plan;
  try {
    plan = await planRecovery(rootPath);
  } catch {
    // A scan we cannot complete removes nothing. The sweep is a convenience; the
    // recovery UI and eject remain, so failing quietly costs the user nothing.
    return { removed: [], held: [], ran: true };
  }

  const removed: string[] = [];
  for (const leftover of plan.discardable) {
    try {
      await unlink(join(rootPath, leftover.path));
      removed.push(leftover.path);
    } catch {
      // Already gone, or not ours to delete. Either way, not worth failing a sync.
    }
  }

  removed.push(...(await removeOrphanedPathruleFiles(rootPath)));

  return {
    removed,
    held: [...plan.restorable, ...plan.needsChoice].map((l) => l.path),
    ran: true,
  };
}
