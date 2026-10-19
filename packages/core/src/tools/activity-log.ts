// SPDX-License-Identifier: Apache-2.0
//
// The activity log handler: the write path every MCP surface shares, with the taxonomy and the
// storage clamps (activity-limits.ts, re-exported here). The backend owns the insert; the handler
// words the demo refusal and clamps what the agent sent so a log always lands in one call.

import { normalizeActivityProvenance, type ActivityProvenance } from "../activity/activity-leads.js";
import type { ActivityFriction, ActivityTeamIntelligenceSignal } from "../index.js";
import { DEMO_READONLY_MESSAGE, type ToolContext } from "./types.js";
import {
  clampFilesTouched,
  clampTaskSummary,
  MAX_APPLIED_MEMORY_IDS,
  MAX_SUBJECTS,
  type ActivityAction,
  type ActivityDomain,
  type ActivityScope,
  type AiClient,
  type FilesTouched,
} from "./activity-limits.js";

export * from "./activity-limits.js";

// ── Interfaces ──────────────────────────────────────────────────────────────

// Neural heatmap friction aggregates. The hook supervisor / PostToolUse
// path is expected to count tool invocations + failures locally, then
// pass the totals here. Raw tool input and raw error text MUST NEVER be
// forwarded — only short lowercase codes (max 20, max 40 chars each,
// `^[a-z0-9][a-z0-9_-]*$`). The DB-side migration enforces the shape.
//
// The hook DOES populate these: handlePostToolUse calls m46RecordToolOutcome on
// every outcome, which appends to <PATHRULE_HOME>/cache/tool-outcomes/, and the
// MCP server drains that file at the log_activity boundary. Callers outside that
// path (Studio's host-side logger) may still omit them; the row then stores zeroes.
export type ActivityFrictionInput = ActivityFriction;

export interface ActivityLogInput {
  provenance?: ActivityProvenance;
  workspaceId: string;
  nodePath: string;
  domain: ActivityDomain;
  action: ActivityAction;
  scope: ActivityScope;
  subjects: string[];
  taskSummary: string;
  /** Optional + tolerant: a missing/malformed value is clamped to an empty map by
   *  writeActivityLog, never rejected (logging must land in one call). */
  filesTouched?: FilesTouched;
  aiClient?: AiClient;
  friction?: ActivityFrictionInput;
  /** Session identifier from the hook event — used for buffer attribution. */
  sessionId?: string;
  /**
   * Explicit positive signal channel. Memory ids the agent actually
   * consulted and applied this turn. When provided alongside a sessionId,
   * the writer fires `pathrule_record_applied_memories` after the activity
   * insert. Best-effort: silently dropped when no recent context_injection
   * matches the session.
   */
  appliedMemoryIds?: string[];
  /**
   * Exploration-suppression signal (observational, zero extra tokens).
   * Read-only discovery calls, file-writing calls, and the derived sufficiency
   * verdict for this turn, persisted on the activity row. Omit for a turn with no
   * tool stream (the row then stays `unknown`, excluded from the weekly rate).
   */
  exploreCalls?: number;
  editCalls?: number;
  contextSufficiency?: "sufficient" | "explored" | "unknown";
  /** Compact prompt-behavior signal; no raw prompt or embedding. */
  teamIntelligenceSignal?: ActivityTeamIntelligenceSignal;
}

export interface ActivityLogRow {
  provenance?: ActivityProvenance;
  id: string;
  workspace_id: string;
  node_path: string;
  domain: string;
  action: string;
  scope: string;
  subjects: string[];
  task_summary: string;
  files_touched: FilesTouched;
  ai_client: string;
  detail_level: string;
  status: string;
  created_at: string;
  tool_call_count?: number;
  tool_failure_count?: number;
  tool_failure_codes?: string[];
  /** Exploration-suppression signal (undefined on LocalBackend / legacy rows). */
  explore_calls?: number;
  edit_calls?: number;
  context_sufficiency?: "sufficient" | "explored" | "unknown";
  team_intelligence_score?: number;
  team_intelligence_category?: ActivityTeamIntelligenceSignal["category"];
  team_intelligence_surface?: ActivityTeamIntelligenceSignal["surface"];
}

// ── Write ───────────────────────────────────────────────────────────────────

export async function writeActivityLog(
  ctx: ToolContext,
  input: ActivityLogInput,
): Promise<ActivityLogRow> {
  // The insert (+ subjects/friction normalization, session/user stamping,
  // and the applied-memory signal) is owned by the backend. The demo-guard policy
  // stays here in the handler; subjects/friction/applied-memory ride along on the input.
  if (!ctx.backend) throw new Error("No backend configured.");
  if (await ctx.backend.isDemoWorkspace(input.workspaceId)) {
    throw new Error(DEMO_READONLY_MESSAGE);
  }

  // Single chokepoint for storage clamps: every caller of writeActivityLog passes through it.
  const filesTouched = clampFilesTouched(input.filesTouched);
  const supplied = normalizeActivityProvenance(input.provenance);
  const provenance = supplied ? normalizeActivityProvenance({
    ...supplied, storedFileCount: filesTouched.total,
    observedFileCount: Math.max(supplied.observedFileCount, filesTouched.total),
  }) : undefined;
  const rec = await ctx.backend.logActivity({
    provenance,
    workspaceId: input.workspaceId,
    nodePath: input.nodePath,
    domain: input.domain,
    action: input.action,
    scope: input.scope,
    subjects: input.subjects.slice(0, MAX_SUBJECTS),
    taskSummary: clampTaskSummary(input.taskSummary),
    filesTouched,
    aiClient: input.aiClient,
    sessionId: input.sessionId,
    friction: input.friction,
    appliedMemoryIds: input.appliedMemoryIds?.slice(0, MAX_APPLIED_MEMORY_IDS),
    exploreCalls: input.exploreCalls,
    editCalls: input.editCalls,
    contextSufficiency: input.contextSufficiency,
    teamIntelligenceSignal: input.teamIntelligenceSignal,
  });

  // Map the backend's ActivityRecord back to the snake_case row the MCP wrapper echoes
  // (id/created_at + verbose full-row dump).
  return {
    provenance: rec.provenance,
    id: rec.id,
    workspace_id: rec.workspaceId,
    node_path: rec.nodePath,
    domain: rec.domain,
    action: rec.action,
    scope: rec.scope,
    subjects: rec.subjects,
    task_summary: rec.taskSummary,
    files_touched: rec.filesTouched,
    ai_client: rec.aiClient,
    detail_level: rec.detailLevel ?? "standard",
    status: rec.status ?? "active",
    created_at: rec.createdAt,
    tool_call_count: rec.toolCallCount,
    tool_failure_count: rec.toolFailureCount,
    tool_failure_codes: rec.toolFailureCodes,
    explore_calls: rec.exploreCalls,
    edit_calls: rec.editCalls,
    context_sufficiency: rec.contextSufficiency,
    team_intelligence_score: rec.teamIntelligenceScore,
    team_intelligence_category: rec.teamIntelligenceCategory,
    team_intelligence_surface: rec.teamIntelligenceSurface,
  };
}
