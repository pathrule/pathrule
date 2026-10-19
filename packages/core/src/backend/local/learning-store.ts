// SPDX-License-Identifier: Apache-2.0
// LocalBackend's advisory learning claims and their durable retirements, over its SQLite
// handle. Kept out of local-backend.ts (a tracked hotspot) so the class methods delegate
// here in one line each; the statements are the class's own, moved verbatim.

import type Database from "better-sqlite3";
import {
  learningClaimLimit,
  learningRevisionConflict,
  parseLearningClaimRows,
  requireLearningClaim,
  requireLearningRevision,
  requireWritableLearningClaim,
  warnInvalidLearningRows,
  type LearningClaim,
  type LearningClaimRevision,
} from "../../project-learning/claims.js";

type Db = InstanceType<typeof Database>;

export async function putLearningClaimRow(db: Db, input: LearningClaim): Promise<LearningClaim> {
  const claim = requireWritableLearningClaim(input);
  if ((await retiredLearningClaimRows(db, claim.workspaceId, [claim.id])).length)
    throw learningRevisionConflict();
  db.prepare(
    "INSERT OR IGNORE INTO learning_claims (workspace_id, id, claim, created_at) VALUES (?, ?, ?, ?)",
  ).run(claim.workspaceId, claim.id, JSON.stringify(claim), new Date().toISOString());
  const row = db
    .prepare("SELECT claim FROM learning_claims WHERE workspace_id = ? AND id = ?")
    .get(claim.workspaceId, claim.id) as { claim: string };
  return requireLearningClaim(JSON.parse(row.claim));
}

export async function retiredLearningClaimRows(
  db: Db,
  workspaceId: string,
  ids: string[],
): Promise<string[]> {
  const find = db.prepare("SELECT 1 FROM learning_claim_retirements WHERE workspace_id=? AND id=?");
  return ids.slice(0, 200).filter((id) => !!find.get(workspaceId, id));
}

export async function reviseLearningClaimRow(
  db: Db,
  raw: LearningClaimRevision,
): Promise<{ status: "applied"; id: string }> {
  const input = requireLearningRevision(raw);
  db.transaction(() => {
    const prior = db
      .prepare(
        "SELECT replacement_id FROM learning_claim_retirements WHERE workspace_id=? AND id=?",
      )
      .get(input.workspaceId, input.id) as { replacement_id: string | null } | undefined;
    if (prior) {
      if (prior.replacement_id !== (input.replacement?.id ?? null))
        throw learningRevisionConflict();
      return;
    }
    if (
      !db
        .prepare("SELECT 1 FROM learning_claims WHERE workspace_id=? AND id=?")
        .get(input.workspaceId, input.id)
    )
      throw new Error("Learning claim not found; inspect learning before revising");
    if (input.replacement) {
      if (
        db
          .prepare("SELECT 1 FROM learning_claim_retirements WHERE workspace_id=? AND id=?")
          .get(input.workspaceId, input.replacement.id)
      )
        throw learningRevisionConflict();
      db.prepare(
        "INSERT OR IGNORE INTO learning_claims(workspace_id,id,claim,created_at) VALUES(?,?,?,?)",
      ).run(
        input.workspaceId,
        input.replacement.id,
        JSON.stringify(input.replacement),
        new Date().toISOString(),
      );
    }
    // Keep the original locally for recovery; delivery excludes retired identities.
    db.prepare(
      "INSERT INTO learning_claim_retirements(workspace_id,id,replacement_id) VALUES(?,?,?)",
    ).run(input.workspaceId, input.id, input.replacement?.id ?? null);
  })();
  return { status: "applied", id: input.id };
}

export async function listLearningClaimRows(
  db: Db,
  workspaceId: string,
  limit = 100,
): Promise<LearningClaim[]> {
  const rows = db
    .prepare(
      "SELECT claim FROM learning_claims c WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM learning_claim_retirements r WHERE r.workspace_id=c.workspace_id AND r.id=c.id) ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(workspaceId, learningClaimLimit(limit)) as Array<{ claim: string }>;
  // Per row, like the cloud read: one unreadable cell must not hide every other claim.
  const { claims, invalid } = parseLearningClaimRows(
    rows.map((row) => {
      try {
        return JSON.parse(row.claim) as unknown;
      } catch {
        return null;
      }
    }),
    workspaceId,
  );
  warnInvalidLearningRows("local", workspaceId, invalid);
  return claims;
}
