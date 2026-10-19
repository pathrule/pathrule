// SPDX-License-Identifier: Apache-2.0
// The refresh-queue contract types + the pure row mapper, split out of
// refreshes.ts so the core backends can import them without dragging the
// ToolContext/database-typed handler layer into this shared export set.
// refreshes.ts re-exports these — every existing import path keeps working.

export type RefreshStatus = "pending" | "in_progress" | "applied" | "rejected" | "superseded";

export interface RefreshRow {
  id: string;
  workspaceId: string;
  suggestionId: string | null;
  subjectType: "memory" | "rule";
  subjectId: string;
  formulaId: string;
  status: RefreshStatus;
  requestedByUserId: string;
  claimedByAi: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
  updatedAt: string;
  brief: RefreshBrief;
}

/**
 * The AI-facing payload. Every field is intended for an LLM to read — no
 * database metadata leakage. Optional `proposedPatch` is filled by Haiku for
 * DB-only formulas (milestone_resolved, expired_date, title_pair_conflict).
 */
export interface RefreshBrief {
  subject: {
    id: string;
    type: "memory" | "rule";
    title: string;
    nodePath: string;
    body: string;
  };
  signal: {
    formulaId: string;
    humanReason: string;
    detectedAt: string;
    rawSignals: Record<string, unknown>;
  };
  aiInstructions: string;
  proposedPatch?: {
    newBody: string;
    reasoning: string;
    confidence: number;
    source: "haiku" | "haiku_pending" | "none";
  };
}

/** The raw `suggestion_refreshes` row shape. Exported so every backend reuses `rowToRefresh`. */
export type RefreshDbRow = {
  id: string;
  workspace_id: string;
  suggestion_id: string | null;
  subject_type: string;
  subject_id: string;
  formula_id: string;
  brief: unknown;
  status: string;
  requested_by_user_id: string;
  claimed_by_ai: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  resolved_note: string | null;
  created_at: string;
  updated_at: string;
};

export function rowToRefresh(row: RefreshDbRow): RefreshRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    suggestionId: row.suggestion_id,
    subjectType: row.subject_type as "memory" | "rule",
    subjectId: row.subject_id,
    formulaId: row.formula_id,
    status: row.status as RefreshStatus,
    requestedByUserId: row.requested_by_user_id,
    claimedByAi: row.claimed_by_ai,
    claimedAt: row.claimed_at,
    resolvedAt: row.resolved_at,
    resolvedNote: row.resolved_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brief: (row.brief ?? {}) as RefreshBrief,
  };
}

export interface PendingRefreshSummary {
  id: string;
  subjectType: "memory" | "rule";
  subjectId: string;
  subjectTitle: string;
  nodePath: string;
  formulaId: string;
  humanReason: string;
  status: RefreshStatus;
  createdAt: string;
  hasProposedPatch: boolean;
}

export interface RequestRefreshResult {
  refreshId: string;
  /** True when an open refresh already existed for the same subject + formula. */
  alreadyPending: boolean;
}
