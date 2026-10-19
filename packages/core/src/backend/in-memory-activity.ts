// SPDX-License-Identifier: Apache-2.0
// The InMemoryKnowledgeBackend's activity record, the projections it files each activity
// into, and its advisory learning claims.
//
// Kept out of in-memory-backend.ts (a tracked hotspot) so the class methods delegate here
// in one line each. The logic is the class's own, moved verbatim: the reference model of
// what LocalBackend persists, so behaviour must not drift between the two.

import {
  learningClaimLimit,
  learningRevisionConflict,
  requireLearningClaim,
  requireLearningRevision,
  requireWritableLearningClaim,
  type LearningClaim,
  type LearningClaimRevision,
} from "../project-learning/claims.js";
import {
  normalizeActivityProvenance,
  type ActivityLeadSource,
} from "../activity/activity-leads.js";
import type { RecentActivityForRouter } from "@pathrule/protocol/intelligence-types.js";
import { activityTouchedPaths } from "./co-change-rank.js";
import type { EpisodeActivity } from "./work-episodes.js";
import type { Activity, ActivityRecord, LogActivityInput } from "./inputs.js";

/** The stored record for one activity. `subjects` arrive already normalized. */
export function activityRecord(
  input: LogActivityInput,
  subjects: string[],
  id: string,
  createdAt: string,
): ActivityRecord {
  return {
    id,
    workspaceId: input.workspaceId,
    nodePath: input.nodePath || "/",
    domain: input.domain,
    action: input.action,
    scope: input.scope,
    subjects,
    provenance: normalizeActivityProvenance(input.provenance),
    taskSummary: input.taskSummary,
    filesTouched: input.filesTouched ?? { total: 0, by_area: {} },
    aiClient: input.aiClient ?? "claude-code",
    detailLevel: "standard",
    status: "active",
    createdAt,
  };
}

/** File one activity into each projection the reference store reads. */
export function projectActivity(
  record: ActivityRecord,
  activities: Activity[],
  routerActivities: RecentActivityForRouter[],
  episodeActivities: EpisodeActivity[],
): void {
  activities.push({
    id: record.id,
    nodePath: record.nodePath,
    domain: record.domain,
    action: record.action,
    taskSummary: record.taskSummary,
    createdAt: record.createdAt,
    scope: record.scope,
    subjects: record.subjects,
    filesTouched: record.filesTouched,
    aiClient: record.aiClient,
  });
  // Router/briefing projection: keeps files_touched (the lean Activity drops it).
  routerActivities.push({
    domain: record.domain,
    action: record.action,
    task_summary: record.taskSummary,
    created_at: record.createdAt,
    node_path: record.nodePath,
    files_touched: record.filesTouched,
  });
  // Retain the episode source (subjects + touched paths); neither is on the Activity type.
  episodeActivities.push({
    id: record.id,
    createdAt: record.createdAt,
    domain: record.domain,
    subjects: record.subjects,
    touchedPaths: activityTouchedPaths(record.filesTouched.by_area, record.nodePath),
    taskSummary: record.taskSummary,
  });
}

/** Learning claims, their retirements, and the content-free activity evidence. */
/** The newest `limit` activities, newest first, from `since` on when given. */
export function recentActivitiesOf(
  activities: readonly Activity[],
  limit: number,
  since?: string,
): Activity[] {
  const kept = since ? activities.filter((a) => a.createdAt >= since) : activities;
  return kept.slice(-limit).reverse();
}

export class InMemoryLearningStore {
  private learningRows: Array<ActivityLeadSource & { workspaceId: string }> = [];

  private learningRetirements = new Map<string, string | null>();
  private learningClaims = new Map<string, LearningClaim>();

  recordActivity(record: ActivityRecord): void {
    this.learningRows.push({
      workspaceId: record.workspaceId,
      id: record.id,
      createdAt: record.createdAt,
      filesTouched: record.filesTouched,
      provenance: record.provenance,
    });
  }

  async putLearningClaim(input: LearningClaim): Promise<LearningClaim> {
    const claim = requireWritableLearningClaim(input);
    const key = `${claim.workspaceId}:${claim.id}`;
    if (this.learningRetirements.has(key)) throw learningRevisionConflict();
    if (!this.learningClaims.has(key)) this.learningClaims.set(key, claim);
    return requireLearningClaim(this.learningClaims.get(key));
  }

  async retiredLearningClaimIds(workspaceId: string, ids: string[]): Promise<string[]> {
    return ids.slice(0, 200).filter((id) => this.learningRetirements.has(`${workspaceId}:${id}`));
  }

  async reviseLearningClaim(
    raw: LearningClaimRevision,
  ): Promise<{ status: "applied"; id: string }> {
    const input = requireLearningRevision(raw),
      key = `${input.workspaceId}:${input.id}`;
    if (this.learningRetirements.has(key)) {
      if (this.learningRetirements.get(key) !== (input.replacement?.id ?? null))
        throw learningRevisionConflict();
    } else {
      if (!this.learningClaims.has(key))
        throw new Error("Learning claim not found; inspect learning before revising");
      if (input.replacement) {
        const replacementKey = `${input.workspaceId}:${input.replacement.id}`;
        if (this.learningRetirements.has(replacementKey)) throw learningRevisionConflict();
        if (!this.learningClaims.has(replacementKey))
          this.learningClaims.set(replacementKey, input.replacement);
      }
      this.learningRetirements.set(key, input.replacement?.id ?? null);
    }
    return { status: "applied", id: input.id };
  }

  async listLearningClaims(workspaceId: string, limit = 100): Promise<LearningClaim[]> {
    return [...this.learningClaims.values()]
      .reverse()
      .filter(
        (c) =>
          c.workspaceId === workspaceId && !this.learningRetirements.has(`${workspaceId}:${c.id}`),
      )
      .slice(0, learningClaimLimit(limit))
      .map(requireLearningClaim);
  }

  learningActivities(workspaceId: string, limit = 200): Promise<ActivityLeadSource[]> {
    return Promise.resolve(
      this.learningRows
        .filter((r) => r.workspaceId === workspaceId)
        .slice(-Math.max(1, Math.min(200, limit)))
        .reverse(),
    );
  }
}
