// SPDX-License-Identifier: Apache-2.0
/**
 * The delivery gate for GROUNDED advisory atoms (`@pathrule/agent-ir/atoms/grounded.js`).
 *
 * A grounded atom is active without a person's approval only while every span it delivers is
 * still verbatim in its source. That is re-proved here, against the source's CURRENT text, every
 * time the hook index is built, so no edit path (MCP, CLI, console, sync) has to remember to
 * invalidate it. A source that is gone, archived or rewritten without the evidence silences the
 * atom. Human-approved atoms pass through unchanged.
 */
import type Database from "better-sqlite3";
import { groundingHolds, type GroundableAtom } from "@pathrule/agent-ir/atoms/grounded.js";

/** SQL for the authorities whose active atoms are delivered. */
export const DELIVERABLE_ADVISORY_AUTHORITIES = "('human','grounded')";

function currentSourceText(db: Database.Database, source: GroundableAtom["source"]): string | null {
  const table = source.kind === "rule" ? "rules" : "memories";
  const row = db.prepare(`SELECT content FROM ${table} WHERE id = ? AND status = 'active'`).get(source.id) as { content?: string } | undefined;
  return typeof row?.content === "string" ? row.content : null;
}

export function groundedNow(db: Database.Database, atom: GroundableAtom): boolean {
  return atom.authority !== "grounded" || groundingHolds(atom, currentSourceText(db, atom.source));
}
