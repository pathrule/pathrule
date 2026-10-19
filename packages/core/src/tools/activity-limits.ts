// SPDX-License-Identifier: Apache-2.0
//
// The activity taxonomy and the storage clamps, with no imports, so a surface that cannot bundle
// the rest of @pathrule/core (the Cloud Worker) clamps exactly as the local writer does.
// activity-log.ts re-exports all of it.

// ── Taxonomy enums ──────────────────────────────────────────────────────────

export const VALID_DOMAINS = [
  "ui",
  "backend",
  "database",
  "infra",
  "config",
  "test",
  "docs",
] as const;

export const VALID_ACTIONS = ["create", "update", "fix", "refactor", "delete", "style"] as const;

export const VALID_SCOPES = [
  "component",
  "page",
  "hook",
  "store",
  "api",
  "migration",
  "service",
  "model",
  "util",
  "project",
] as const;

export const VALID_AI_CLIENTS = [
  "claude-code",
  "cursor",
  "windsurf",
  "codex",
  "copilot",
  "cloud-connector",
  "other",
] as const;

export type ActivityDomain = (typeof VALID_DOMAINS)[number];
export type ActivityAction = (typeof VALID_ACTIONS)[number];
export type ActivityScope = (typeof VALID_SCOPES)[number];
export type AiClient = (typeof VALID_AI_CLIENTS)[number];

export interface FilesTouched {
  total: number;
  by_area: Record<string, string[]>;
  /**
   * Set by `normalizeFilesTouched` to attest that every path here is canonical
   * workspace-relative form. The co-change materializer REQUIRES it
   * (`files_touched ->> 'normalized_v1' = 'true'`) so it never builds a co-change
   * pair out of an absolute path or a stray format.
   *
   * It went unwritten from its introduction until 2026-08-22: the migration's consumer looked for
   * this key, no producer ever set it, and `co_change_weights` stayed EMPTY across 92
   * successful cron runs with 0 errors — meaning one of retrieval's three signals was
   * dead while every indicator said healthy. Do not drop this field when copying a
   * FilesTouched; `clampFilesTouched` carries it through deliberately.
   */
  normalized_v1?: boolean;
}

// ── Storage clamps (cost guard; never throw, never reject) ───────────────────
//
// Logging is a side-effect that must ALWAYS succeed in a single call. We never
// hard-reject an oversized payload at the schema layer (that surfaces a Zod
// `too_big` validation error which the model reads as "fix args and retry",
// causing multi-minute retry loops). Instead the input schema stays permissive
// and every size bound is enforced here, gracefully, so the row lands small and
// the call returns ok on the first try regardless of what the agent sent.

/** Soft target surfaced to the agent as a non-blocking nudge. */
export const TASK_SUMMARY_TARGET_CHARS = 300;
/** Hard STORAGE ceiling (not a reject threshold): summaries are clamped here. */
export const TASK_SUMMARY_HARD_MAX_CHARS = 500;
/** Subjects kept per row (cost guard); extras are dropped, never rejected. */
export const MAX_SUBJECTS = 5;
/** Applied-memory ids kept per row (applied-memory signal cap). */
export const MAX_APPLIED_MEMORY_IDS = 20;
/** Total file paths kept across all areas (the jsonb cost guard). */
export const MAX_FILES_TOUCHED = 60;

/** Count by code points so emoji/astral chars match the agent-facing char count. */
export function activityCharCount(value: string): number {
  return Array.from(value).length;
}

/**
 * Clamp a task summary to the hard storage ceiling WITHOUT ever throwing.
 * Within the ceiling the original is returned untouched. Beyond it, the text is
 * trimmed back to the last word boundary (so we never cut mid-word) and an
 * ellipsis is appended. This is a cost guard, not a reject: callers still get
 * ok:true and the agent is nudged via the response warning to write shorter.
 */
export function clampTaskSummary(value: string): string {
  const cp = Array.from(value);
  if (cp.length <= TASK_SUMMARY_HARD_MAX_CHARS) return value;
  const sliceLen = TASK_SUMMARY_HARD_MAX_CHARS - 1; // reserve one for the ellipsis
  let head = cp.slice(0, sliceLen).join("");
  const lastSpace = head.lastIndexOf(" ");
  // Only back off to the word boundary when it keeps most of the budget.
  if (lastSpace > sliceLen * 0.6) head = head.slice(0, lastSpace);
  return `${head.trimEnd()}…`;
}

/**
 * Cap the total number of stored file paths across all areas (the unbounded
 * jsonb is the real per-row cost driver at volume). Areas are filled in order
 * until the budget is exhausted; `total` is recomputed to what was actually
 * kept. Never throws.
 */
export function clampFilesTouched(filesTouched: FilesTouched | undefined | null): FilesTouched {
  let budget = MAX_FILES_TOUCHED;
  const by_area: Record<string, string[]> = {};
  // Tolerant: a missing/malformed files_touched must never throw here (logging is a
  // best-effort side-effect that has to land in one call). Coerce to an empty map.
  const inputAreas = filesTouched?.by_area;
  const entries = inputAreas && typeof inputAreas === "object" ? Object.entries(inputAreas) : [];
  for (const [area, paths] of entries) {
    if (budget <= 0) break;
    if (!Array.isArray(paths)) continue;
    const kept = paths.filter((p) => typeof p === "string").slice(0, budget);
    if (kept.length > 0) {
      by_area[area] = kept;
      budget -= kept.length;
    }
  }
  const total = Object.values(by_area).reduce((sum, paths) => sum + paths.length, 0);
  // Carry the normalization attestation through. Clamping drops PATHS (budget), never
  // the claim about the paths that survive — they were normalized either way. Losing it
  // here would silently re-break the co-change materializer, which filters on it.
  return filesTouched?.normalized_v1 === true
    ? { total, by_area, normalized_v1: true }
    : { total, by_area };
}
