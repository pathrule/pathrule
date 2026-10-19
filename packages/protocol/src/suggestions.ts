// SPDX-License-Identifier: Apache-2.0
// The shapes of Knowledge Maintenance's detectors ("formulas"): what a detector reports, the
// suggestion rows the sweep keeps, and which detectors run when. The detectors themselves are
// an engine's (`MaintenanceAnalyzer`); these shapes are what the host, a surface and its
// renderer exchange with them.

export type FormulaId =
  | "zero_injection"
  | "last_touched"
  | "dead_path_ref"
  | "empty_node"
  | "expired_date"
  | "milestone_resolved"
  | "package_drift"
  | "title_pair_conflict"
  | "duplicate_memory"
  | "knowledge_gap_path"
  | "git_memory_impact"
  | "agent_flag"
  | "knowledge_map_structure"
  | "knowledge_coverage_gap";

export type SubjectType = "memory" | "rule" | "path";

export interface Suggestion {
  id: string;
  workspaceId: string;
  subjectType: SubjectType;
  /** UUID for memory/rule subjects; null for path subjects. */
  subjectId: string | null;
  /** Workspace-relative path for path subjects; null otherwise. */
  subjectPath: string | null;
  formulaId: FormulaId;
  confidence: number;
  details: Record<string, unknown>;
  triggeredAt: string;
  lastSeenRunId: string;
  resolvedAt: string | null;
}

/** Stable key for a suggestion regardless of subject flavor. */
export function suggestionSubjectKey(
  subjectType: SubjectType,
  subjectId: string | null,
  subjectPath: string | null,
): string {
  if (subjectType === "path") return `path:${subjectPath ?? ""}`;
  return `${subjectType}:${subjectId ?? ""}`;
}

export interface DismissalRow {
  id: string;
  workspaceId: string;
  subjectType: SubjectType;
  subjectId: string;
  formulaId: FormulaId | null;
  action: "keep" | "snooze" | "archive" | "restore";
  dismissedAt: string;
  dismissCount: number;
  nextRecheckAt: string | null;
  userId: string;
}

export interface RunRow {
  id: string;
  workspaceId: string;
  formulaId: FormulaId;
  startedAt: string;
  finishedAt: string | null;
  rowsEvaluated: number | null;
  suggestionsEmitted: number | null;
  status: "running" | "completed" | "error" | "skipped_offline";
  error: string | null;
}

/** One subject a detector flags. */
export interface FormulaHit {
  subjectType: SubjectType;
  subjectId: string | null;
  subjectPath?: string | null;
  confidence: number;
  details: Record<string, unknown>;
}

export type FormulaSnapshotMode = "replace" | "append";

export interface FormulaRunOutput {
  hits: FormulaHit[];
  /**
   * replace: absence in this run resolves a previous hit.
   * append: a hit remains actionable until a newer fingerprint or a user
   * decision supersedes it. Git impact uses append because an unrelated later
   * commit does not prove that an earlier affected memory became current.
   */
  snapshotMode?: FormulaSnapshotMode;
  /** Number of subjects inspected, distinct from the number of emitted hits. */
  evaluatedCount?: number;
  /** Bounded, content-free checkpoint persisted only after the sweep succeeds. */
  checkpoint?: Record<string, unknown>;
}

export type FormulaCadence = "daily" | "monthly" | "on_change";

/** A detector as the sweep schedules it. */
export interface FormulaSchedule {
  id: FormulaId;
  cadence: FormulaCadence;
  /** Retired detectors stay listed and never run. */
  active: boolean;
  /** Whether the engine has an implementation; a detector without one is skipped. */
  runnable: boolean;
}
