// SPDX-License-Identifier: Apache-2.0
//
// Suggestion refresh queue — Pathrule's handoff channel to the user's AI.
//
// Flow:
//   1. User clicks "AI'ye devret" on a stale suggestion → a row lands here
//      (status='pending').
//   2. The hook supervisor surfaces the pending count in the session digest.
//   3. The AI calls pathrule_list_pending_refreshes → pathrule_get_refresh_brief
//      → (does its work using its own tools) → pathrule_update_memory →
//      pathrule_resolve_refresh.
//
// We never read the user's code. The brief tells the AI what's stale and
// what to check; the AI's own file-access tools do the reading.

import type { ToolContext, ToolResult } from "./types.js";
import { mapStoreError } from "./types.js";
import type { PendingRefreshSummary, RefreshRow, RequestRefreshResult } from "@pathrule/protocol/refresh-types.js";

// The contract types and the pure row mapper live in protocol. Re-exported verbatim so
// every existing import path keeps working.
export { rowToRefresh } from "@pathrule/protocol/refresh-types.js";
export type {
  RefreshStatus,
  RefreshRow,
  RefreshBrief,
  RefreshDbRow,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/protocol/refresh-types.js";

// --- list --------------------------------------------------------------------

export interface ListPendingRefreshesArgs {
  workspace_id: string;
  include_in_progress?: boolean;
}

export async function listPendingRefreshesHandler(
  ctx: ToolContext,
  args: ListPendingRefreshesArgs,
): Promise<ToolResult<PendingRefreshSummary[]>> {
  // The queue read is owned by the backend (cloud: suggestion_refreshes;
  // local: refresh_tasks projected onto the same summary shape).
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const data = await ctx.backend.listPendingRefreshes(
      args.workspace_id,
      args.include_in_progress,
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// --- get brief (and claim) ---------------------------------------------------

export interface GetRefreshBriefArgs {
  refresh_id: string;
  claimed_by?: string;
}

export async function getRefreshBriefHandler(
  ctx: ToolContext,
  args: GetRefreshBriefArgs,
): Promise<ToolResult<RefreshRow>> {
  // Claim-on-read (pending → in_progress) lives in the backend.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const data = await ctx.backend.getRefreshBrief(args.refresh_id, args.claimed_by);
    return { ok: true, data };
  } catch (err) {
    const e = err as { code?: string; message: string };
    if (e.message?.includes("not found")) {
      return {
        ok: false,
        error: { code: "not_found", message: `Refresh ${args.refresh_id} not found` },
      };
    }
    return { ok: false, error: mapStoreError(e) };
  }
}

// --- resolve ----------------------------------------------------------------

export interface ResolveRefreshArgs {
  refresh_id: string;
  status: "applied" | "rejected";
  note?: string;
  claimed_by?: string;
}

export async function resolveRefreshHandler(
  ctx: ToolContext,
  args: ResolveRefreshArgs,
): Promise<ToolResult<RefreshRow>> {
  // The resolve transaction (status update + cloud-only side-effects:
  // suggestion mirror, dismissal window, creator/admin notifications) is owned by the
  // backend. LocalBackend just flips the status; those side-effects are cloud curation.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const data = await ctx.backend.resolveRefresh(
      args.refresh_id,
      args.status,
      args.note,
      args.claimed_by,
    );
    return { ok: true, data };
  } catch (err) {
    const e = err as { code?: string; message: string };
    if (e.message?.includes("not found")) {
      return {
        ok: false,
        error: { code: "not_found", message: `Refresh ${args.refresh_id} not found` },
      };
    }
    return { ok: false, error: mapStoreError(e) };
  }
}

// --- request (AI flags a stale memory/rule) ---------------------------------

export type RequestRefreshKind =
  | "drift"
  | "contradicts_code"
  | "duplicate"
  | "too_narrow"
  | "unclear";

export interface RequestRefreshArgs {
  subject_type: "memory" | "rule";
  subject_id: string;
  reason: string;
  kind?: RequestRefreshKind;
}

export async function requestRefreshHandler(
  ctx: ToolContext,
  args: RequestRefreshArgs,
): Promise<ToolResult<RequestRefreshResult>> {
  // Filing a refresh is owned by the backend (cloud: the
  // pathrule_request_refresh RPC builds the brief + asserts membership + is
  // idempotent server-side; local: an idempotent insert into refresh_tasks).
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const data = await ctx.backend.requestRefresh({
      subjectType: args.subject_type,
      subjectId: args.subject_id,
      reason: args.reason,
      kind: args.kind,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}
