// SPDX-License-Identifier: Apache-2.0
// What get_context returns about the project's own history: prior work from earlier
// sessions, activity-based review priorities, advisory learning claims and the structural
// source map.
//
// Kept out of get-context.ts (a tracked hotspot). The prior-work helpers are the tool's
// own, moved verbatim. The learning fields load in parallel under one latency budget
// (createBudgetedLoader): a slow checkout omits them from this call and never fails it,
// and a load that missed its budget is handed to the next call instead of being wasted.
// Nothing else is reused across calls, so every answer re-verifies claims against the
// working tree.

import type { KnowledgeBackend } from "@pathrule/core";
import { dropUndefined } from "@pathrule/protocol/versioning.js";
import type { DeterministicRoute, RoutingResult } from "@pathrule/protocol/routing-types.js";
import type { WorkEpisodeBrief } from "@pathrule/protocol/intelligence-types.js";
import { buildActivityLeads } from "@pathrule/core/activity/activity-leads.js";
import {
  loadLearningContext,
  type LearningContext,
} from "@pathrule/core/project-learning/claim-service.js";
import {
  createBudgetedLoader,
  excludeVerifiedTargets,
  readLearningStamp,
  refreshProjectMap,
  type ProjectMapContext,
} from "@pathrule/core/project-learning/index.js";
import { capPreview } from "../lib/preview-cap.js";

type HistoryMode = "compact" | "deep";

interface HistoryRequest {
  active: boolean;
  explicit: boolean;
  handoff: boolean;
  mode: HistoryMode;
  query: string;
}

function stripHistoryMarkers(intent: string): string {
  return intent
    .replace(/\+\+history\b\s*(deep\b)?/gi, " ")
    .replace(/\+\+handoff\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHistoryRequest(
  userIntent: string | undefined,
  deterministic: DeterministicRoute | undefined,
  routing: RoutingResult,
): HistoryRequest {
  const raw = userIntent ?? "";
  const explicit = /\+\+history\b/i.test(raw);
  const handoff = /\+\+handoff\b/i.test(raw);
  const deep = /\+\+history\s+deep\b/i.test(raw);
  const natural =
    deterministic?.intent_class === "history_question" ||
    routing.decision?.include?.includes("prior_work") === true;
  const stripped = stripHistoryMarkers(raw);
  return {
    active: explicit || natural,
    explicit,
    handoff,
    mode: deep ? "deep" : "compact",
    query: stripped || raw,
  };
}

function compactPriorWorkForResponse(
  episodes: WorkEpisodeBrief[],
  explicit: boolean,
): WorkEpisodeBrief[] {
  const allowed = explicit ? episodes : episodes.filter((e) => e.confidence !== "low");
  return allowed.map((episode) =>
    dropUndefined({
      id: episode.id,
      title: capPreview(episode.title, 120),
      summary: capPreview(episode.summary, explicit ? 520 : 260),
      subjects: episode.subjects?.slice(0, 6) ?? [],
      paths: episode.paths?.slice(0, explicit ? 8 : 5) ?? [],
      activity_count: episode.activity_count,
      started_at: episode.started_at,
      ended_at: episode.ended_at,
      confidence: episode.confidence,
      evidence_activity_ids: episode.evidence_activity_ids?.slice(0, explicit ? 6 : 3),
    }),
  ) as WorkEpisodeBrief[];
}

/** Prior work for a history question (`++history`, or a natural one), or undefined. */
export async function loadPriorWork(input: {
  backend: KnowledgeBackend | undefined;
  workspaceId: string;
  userIntent: string | undefined;
  userIntentProvided: boolean;
  deterministic: DeterministicRoute | undefined;
  routing: RoutingResult;
}): Promise<WorkEpisodeBrief[] | undefined> {
  const historyRequest = parseHistoryRequest(input.userIntent, input.deterministic, input.routing);
  let priorWork: WorkEpisodeBrief[] | undefined;
  if (
    input.userIntentProvided &&
    historyRequest.active &&
    !historyRequest.handoff &&
    input.backend
  ) {
    await input.backend.refreshWorkEpisodes(input.workspaceId).catch(() => ({
      ok: false,
      episodes_upserted: 0,
    }));
    const found = await input.backend
      .searchWorkEpisodes(
        input.workspaceId,
        historyRequest.query,
        historyRequest.mode,
        historyRequest.mode === "deep" ? 3 : 2,
      )
      .catch(() => [] as WorkEpisodeBrief[]);
    const compact = compactPriorWorkForResponse(found, historyRequest.explicit);
    priorWork = compact.length > 0 ? compact : undefined;
  }
  return priorWork;
}

export interface ProjectLearningFields {
  activity_leads?: ReturnType<typeof buildActivityLeads>;
  project_map?: ProjectMapContext;
  project_learning_claims?: LearningContext;
}

interface LoadedFields {
  fields: ProjectLearningFields;
}

const PROJECT_LEARNING_BUDGET_MS = 400;
let budgetMs = PROJECT_LEARNING_BUDGET_MS;
const loads = createBudgetedLoader<LoadedFields>(0);

/** Test seam: a slower machine must not turn an end-to-end assertion into a budget race. */
export function setProjectLearningBudgetForTest(ms: number | null): void {
  budgetMs = ms ?? PROJECT_LEARNING_BUDGET_MS;
  loads.clear();
}

/** The learning fields for a non-minimal get_context call; `{}` when the budget ran out. */
export async function loadProjectLearningFields(input: {
  backend: KnowledgeBackend | undefined;
  workspaceId: string;
  localRootPath: string | null | undefined;
  scope: string;
}): Promise<ProjectLearningFields> {
  const { backend, workspaceId, localRootPath, scope } = input;
  const stamp = await readLearningStamp(workspaceId).catch(() => "");
  const loaded = await loads.load(
    JSON.stringify([workspaceId, localRootPath ?? null, scope]),
    stamp,
    async () => {
      const [learningRows, learnedContext, projectMap] = await Promise.all([
        backend?.learningActivities
          ? backend.learningActivities(workspaceId, 100).catch(() => [])
          : [],
        localRootPath && backend
          ? loadLearningContext({ backend, workspaceId, localRootPath, scope })
          : undefined,
        localRootPath ? refreshProjectMap({ workspaceId, localRootPath, scope }) : undefined,
      ]);
      const activityLeads = buildActivityLeads(learningRows, scope, 5);
      return {
        fields: {
          activity_leads: activityLeads.targets.length ? activityLeads : undefined,
          // Loaded beside the claims, so targets a current claim covers are dropped here.
          project_map: projectMap
            ? excludeVerifiedTargets(projectMap, learnedContext?.claims ?? [])
            : undefined,
          project_learning_claims: learnedContext,
        },
      };
    },
    budgetMs,
  );
  return loaded ? loaded.fields : {};
}
