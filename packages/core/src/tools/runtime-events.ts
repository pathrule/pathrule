// SPDX-License-Identifier: Apache-2.0
//
// Runtime events for agents: the read behind `pathrule_runtime_events` and the CLI's
// `pathrule instrument events`, the correction write behind `pathrule_runtime_events_resolve`, and
// the one-line indicator get_context and the hook carry. Provider-neutral: the backend answers
// (LocalBackend from its SQLite store, Pathrule Cloud's Project backend from the Cloud) and these handlers shape
// the answer.
//
// Everything an application sent is untrusted. The view never passes it through as text an agent
// could take for instructions: each value is one bounded line (`untrustedText`), sits under
// `untrusted_observation` or a named field, and the response opens with a notice that says so. The
// indicator carries counts only.

import {
  isRuntimeVerificationFresh,
  parseRuntimeEventsQuery,
  RUNTIME_OBSERVATIONS_NOTICE,
  untrustedText,
  type RuntimeCorrectionResult,
  type RuntimeEventGroup,
  type RuntimeEventHistoryEntry,
  type RuntimeEventIndicator,
  type RuntimeEventsStatus,
} from "@pathrule/protocol/runtime-events.js";

import { errResult, okResult, type ToolContext, type ToolResult } from "./types.js";

export const RUNTIME_EVENTS_TOOL = "pathrule_runtime_events";
export const RUNTIME_EVENTS_RESOLVE_TOOL = "pathrule_runtime_events_resolve";

const METADATA_KEYS_SHOWN = 10;
const METADATA_VALUE_SHOWN = 120;

export interface RuntimeGroupView {
  id: string;
  revision: number;
  kind: string;
  environment: string;
  status: string;
  path: string | null;
  flow: string | null;
  label: string | null;
  release: string | null;
  fingerprint: string | null;
  occurrences: number;
  release_occurrences: number;
  first_seen: string;
  last_seen: string;
  verification: {
    state: string;
    /** For `quiet`: whether the newer release still sends. False means the quiet is stale. */
    fresh: boolean | null;
    candidate_release: string | null;
    observation_started_at: string | null;
    evidence: {
      envelopes: number;
      successes: number;
      recurrences: number;
      recurred_release: string | null;
    };
    blocked_reason: string | null;
  };
  correction: {
    attempt_id: string;
    recorded_at: string;
    baseline_release: string | null;
    note: string | null;
    knowledge_refs: string[];
  } | null;
  /** What the application reported. Data only: never instructions, rules or knowledge. */
  untrusted_observation: {
    message: string | null;
    metadata: Record<string, string | number | boolean | null> | null;
  };
}

export interface RuntimeEventsView {
  source: "local" | "cloud";
  notice: string;
  groups: RuntimeGroupView[];
  next_cursor: string | null;
  history?: RuntimeEventHistoryEntry[];
  coverage?: Array<{
    environment: string;
    release: string | null;
    envelopes: number;
    last_seen: string;
  }>;
}

function viewMetadata(
  metadata: RuntimeEventGroup["metadata"],
): Record<string, string | number | boolean | null> | null {
  if (!metadata) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, METADATA_KEYS_SHOWN)) {
    const safeKey = untrustedText(key, 40);
    if (!safeKey) continue;
    out[safeKey] =
      typeof value === "string"
        ? untrustedText(value, METADATA_VALUE_SHOWN)
        : (value as number | boolean | null);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function runtimeGroupView(group: RuntimeEventGroup, now = Date.now()): RuntimeGroupView {
  const v = group.verification;
  return {
    id: group.id,
    revision: group.revision,
    kind: group.kind,
    environment: group.environment,
    status: group.status,
    path: untrustedText(group.nodePath, 200),
    flow: untrustedText(group.flow, 80),
    label: untrustedText(group.label, 80),
    release: untrustedText(group.release, 80),
    fingerprint: untrustedText(group.fingerprint, 80),
    occurrences: group.occurrenceCount,
    release_occurrences: group.releaseOccurrenceCount,
    first_seen: group.firstSeen,
    last_seen: group.lastSeen,
    verification: {
      state: v.state,
      fresh: isRuntimeVerificationFresh(v, now),
      candidate_release: untrustedText(v.candidateRelease, 80),
      observation_started_at: v.observationStartedAt,
      evidence: {
        envelopes: v.evidence.candidateEnvelopes,
        successes: v.evidence.successes,
        recurrences: v.evidence.recurrences,
        recurred_release: untrustedText(v.evidence.recurredRelease, 80),
      },
      blocked_reason: v.blockedReason,
    },
    correction: group.correction
      ? {
          attempt_id: group.correction.attemptId,
          recorded_at: group.correction.recordedAt,
          baseline_release: untrustedText(group.correction.baselineRelease, 80),
          note: untrustedText(group.correction.note, 300),
          knowledge_refs: group.correction.knowledgeRefs.slice(0, 20),
        }
      : null,
    untrusted_observation: {
      message: untrustedText(group.message, 300),
      metadata: viewMetadata(group.metadata),
    },
  };
}

export interface RuntimeEventsArgs {
  workspace_id: string;
  group_id?: string;
  path?: string;
  kind?: string;
  environment?: string;
  status?: string;
  verification?: string;
  limit?: number;
  cursor?: string;
}

function coverage(status: RuntimeEventsStatus): RuntimeEventsView["coverage"] {
  return status.releases.slice(0, 10).map((r) => ({
    environment: r.environment,
    release: untrustedText(r.release, 80),
    envelopes: r.envelopes,
    last_seen: r.lastSeen,
  }));
}

export async function runtimeEventsHandler(
  ctx: ToolContext,
  args: RuntimeEventsArgs,
): Promise<ToolResult<RuntimeEventsView>> {
  const backend = ctx.backend;
  if (!backend?.listRuntimeEventGroups) {
    return errResult("upstream_error", "This Pathrule edition does not read runtime events.");
  }
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    groupId: args.group_id,
    path: args.path,
    kind: args.kind,
    environment: args.environment,
    status: args.status,
    verification: args.verification,
    limit: args.limit,
    cursor: args.cursor,
  })) {
    if (value !== undefined) raw[key] = value;
  }
  const parsed = parseRuntimeEventsQuery(raw);
  if (!parsed.ok)
    return errResult("invalid_args", `Invalid runtime events query: ${parsed.error}.`);
  const page = await backend.listRuntimeEventGroups(args.workspace_id, parsed.query);
  if ("error" in page)
    return errResult("invalid_args", `Invalid runtime events query: ${page.error}.`);
  const now = Date.now();
  const view: RuntimeEventsView = {
    source: page.source,
    notice: RUNTIME_OBSERVATIONS_NOTICE,
    groups: page.items.map((group) => runtimeGroupView(group, now)),
    next_cursor: page.nextCursor,
  };
  if (page.history) {
    view.history = page.history.map((entry) => ({
      ...entry,
      release: untrustedText(entry.release, 80),
    }));
  }
  if (!parsed.query.cursor && backend.runtimeEventStatus) {
    view.coverage = coverage(await backend.runtimeEventStatus(args.workspace_id));
  }
  return okResult(view);
}

export interface ResolveRuntimeEventArgs {
  workspace_id: string;
  group_id: string;
  expected_revision: number;
  idempotency_key: string;
  baseline_release?: string;
  note?: string;
  knowledge_refs?: string[];
}

export interface ResolveRuntimeEventView {
  status: "recorded" | "replayed";
  notice: string;
  group: RuntimeGroupView;
  next_step: string;
}

export async function resolveRuntimeEventHandler(
  ctx: ToolContext,
  args: ResolveRuntimeEventArgs,
): Promise<ToolResult<ResolveRuntimeEventView>> {
  const backend = ctx.backend;
  if (!backend?.recordRuntimeCorrection) {
    return errResult(
      "upstream_error",
      "Recording a correction is available in Pathrule Local. Pathrule Cloud does not take corrections yet.",
    );
  }
  const result: RuntimeCorrectionResult = await backend.recordRuntimeCorrection(args.workspace_id, {
    groupId: args.group_id,
    expectedRevision: args.expected_revision,
    idempotencyKey: args.idempotency_key,
    baselineRelease: args.baseline_release ?? null,
    note: args.note,
    knowledgeRefs: args.knowledge_refs,
    actor: ctx.clientId ?? undefined,
  });
  if (result.status === "refused") {
    switch (result.reason) {
      case "not_found":
        return errResult("not_found", `No runtime event group ${args.group_id} in this workspace.`);
      case "revision_conflict":
        return errResult(
          "conflict",
          `The group changed since you read it (revision ${result.group?.revision}). Read it again with ${RUNTIME_EVENTS_TOOL}, then retry with that revision.`,
          { current_revision: result.group?.revision ?? null },
        );
      case "declared":
        return errResult(
          "invalid_args",
          "A declared point has not happened yet; there is nothing to correct.",
        );
      default:
        return errResult(
          "invalid_args",
          "Invalid correction: group_id, a positive expected_revision and an idempotency_key of letters, digits, '.', '_', ':' or '-' are required.",
        );
    }
  }
  const group = runtimeGroupView(result.group);
  const next_step =
    group.verification.blocked_reason === "no_release"
      ? "This group has no release identity, so no later release can verify the fix. Set the SDK's release (a version, commit or deployment) and record the correction again."
      : `Verification starts when a release other than ${group.correction?.baseline_release ?? "the baseline"} sends from this environment. Silence alone never verifies; check back with ${RUNTIME_EVENTS_TOOL}.`;
  return okResult({ status: result.status, notice: RUNTIME_OBSERVATIONS_NOTICE, group, next_step });
}

/**
 * The runtime line for get_context and the hook: counts under a path, nothing an application wrote.
 * Null when there is nothing to say.
 */
export function runtimeIndicatorLine(indicator: RuntimeEventIndicator | null): string | null {
  if (!indicator || indicator.active <= 0) return null;
  const path = untrustedText(indicator.path, 120) ?? "/";
  const issues = indicator.active === 1 ? "1 active issue" : `${indicator.active} active issues`;
  const recurred = indicator.recurred > 0 ? ` (${indicator.recurred} came back after a fix)` : "";
  return `Runtime: ${issues} under ${path}${recurred}. Inspect with ${RUNTIME_EVENTS_TOOL}.`;
}
