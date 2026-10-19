// SPDX-License-Identifier: Apache-2.0
/**
 * Storing a GROUNDED atom, and retiring one the evidence went against.
 *
 * A person's decision always outranks the machine: an atom a person approved or rejected is never
 * re-activated, downgraded or re-proposed by a capture, so the same evidence cannot come back
 * after a "no". A capture of evidence already stored as an engine proposal (`inferred`,
 * `proposed`) activates that row instead of minting a second one.
 *
 * Retirement is the only automatic step down, and it is narrow: a GROUNDED atom whose attributed
 * use failed with STRONG evidence in at least RETIRE_AFTER_FAILED_SESSIONS different sessions, and
 * never succeeded, stops being delivered. Human-approved atoms are never retired by evidence.
 */
import type Database from "better-sqlite3";
import type { CapturedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";

export type GroundedStoreResult = "activated" | "already_active" | "kept_approved" | "kept_declined";

export const RETIRE_AFTER_FAILED_SESSIONS = 2;
export const RETIRED_BY = "pathrule:outcome-evidence";

export function storeGroundedAtom(db: Database.Database, workspaceId: string, atom: CapturedAtom, now: string): GroundedStoreResult {
  const existing = db
    .prepare("SELECT id, authority, status, approved_by FROM knowledge_atoms WHERE workspace_id = ? AND fingerprint = ?")
    .get(workspaceId, atom.fingerprint) as { id: string; authority: string; status: string; approved_by: string | null } | undefined;
  if (existing) {
    if (existing.status === "rejected") return "kept_declined";
    if (existing.authority === "human") return "kept_approved";
    if (existing.authority === "grounded" && existing.status === "active") return "already_active";
    db.prepare("UPDATE knowledge_atoms SET authority = 'grounded', status = 'active', approved_by = NULL, payload = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify({ ...atom, id: existing.id }), now, workspaceId, existing.id);
    return "activated";
  }
  db.prepare(
    `INSERT INTO knowledge_atoms
       (id, workspace_id, kind, subject_type, subject_id, node_path, authority, status, approved_by, fingerprint, payload, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'grounded', 'active', NULL, ?, ?, ?, ?, ?)`,
  ).run(atom.id, workspaceId, atom.kind, atom.source.kind, atom.source.id, atom.source.node_path, atom.fingerprint, JSON.stringify(atom), atom.observed_at, now, now);
  return "activated";
}

/** Retire grounded atoms the outcome evidence went against. Returns the retired ids. */
export function retireFailedGroundedAtoms(db: Database.Database, workspaceId: string, now: string): string[] {
  const rows = db
    .prepare(
      `SELECT a.id FROM knowledge_atoms a
        WHERE a.workspace_id = ? AND a.authority = 'grounded' AND a.status = 'active'
          AND (SELECT COUNT(DISTINCT e.session_id) FROM knowledge_evidence e
                WHERE e.workspace_id = a.workspace_id AND e.atom_id = a.id
                  AND e.event_type = 'outcome_failure' AND e.strength = 'STRONG') >= ?
          AND NOT EXISTS (SELECT 1 FROM knowledge_evidence s
                WHERE s.workspace_id = a.workspace_id AND s.atom_id = a.id AND s.event_type = 'outcome_success')`,
    )
    .all(workspaceId, RETIRE_AFTER_FAILED_SESSIONS) as Array<{ id: string }>;
  const retire = db.prepare("UPDATE knowledge_atoms SET authority = 'inferred', status = 'rejected', approved_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?");
  for (const r of rows) retire.run(RETIRED_BY, now, workspaceId, r.id);
  return rows.map((r) => r.id);
}
