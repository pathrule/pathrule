// SPDX-License-Identifier: Apache-2.0
// LocalBackend's activity_logs writes, the recent activity the consoles read and the
// content-free learning evidence read from them. Kept out of local-backend.ts (a tracked
// hotspot) so the class methods delegate here in one line each.

import type Database from "better-sqlite3";
import {
  normalizeActivityProvenance,
  type ActivityLeadSource,
} from "../../activity/activity-leads.js";
import type { Activity, ActivityRecord, LogActivityInput } from "../inputs.js";
import { normalizeActivitySubjects } from "../in-memory-backend.js";

type Db = InstanceType<typeof Database>;

export function insertActivityRow(
  db: Db,
  input: LogActivityInput,
  id: string,
  createdAt: string,
): ActivityRecord {
  const provenance = normalizeActivityProvenance(input.provenance);
  const subjects = normalizeActivitySubjects(input.subjects);
  const nodePath = input.nodePath || "/";
  const filesTouched = input.filesTouched ?? { total: 0, by_area: {} };
  const aiClient = input.aiClient ?? "claude-code";
  // Friction counts + applied-memory signals are not stored locally.
  db.prepare(
    `INSERT INTO activity_logs (id, workspace_id, node_path, domain, action, scope, subjects,
          task_summary, files_touched, ai_client, created_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    nodePath,
    input.domain,
    input.action,
    input.scope,
    JSON.stringify(subjects),
    input.taskSummary,
    JSON.stringify(filesTouched),
    aiClient,
    createdAt,
    provenance ? JSON.stringify(provenance) : null,
  );
  return {
    id,
    workspaceId: input.workspaceId,
    nodePath,
    domain: input.domain,
    action: input.action,
    scope: input.scope,
    subjects,
    taskSummary: input.taskSummary,
    filesTouched,
    aiClient,
    detailLevel: "standard",
    status: "active",
    provenance,
    createdAt,
  };
}

/**
 * The newest activity rows of a workspace, at or after `since` when given. `rowid DESC` is the
 * insertion-order tiebreaker: created_at alone is ambiguous when rows share a timestamp (a fixed
 * test clock, or sub-millisecond writes), and InMemoryBackend returns newest-inserted-first, so
 * without it the two backends diverge on equal timestamps.
 */
export function recentActivityRows(
  db: Db,
  workspaceId: string,
  limit: number,
  since?: string,
): Activity[] {
  const rows = db
    .prepare(
      `SELECT id, node_path, domain, action, scope, subjects, task_summary, files_touched, ai_client,
          created_at FROM activity_logs WHERE workspace_id = ? AND (? IS NULL OR created_at >= ?)
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(workspaceId, since ?? null, since ?? null, limit) as Array<Record<string, unknown>>;
  const parse = (value: unknown): unknown => {
    try {
      return typeof value === "string" ? JSON.parse(value) : undefined;
    } catch {
      return undefined;
    }
  };
  return rows.map((r) => {
    const subjects = parse(r.subjects);
    return {
      id: r.id as string,
      nodePath: (r.node_path as string | null) ?? null,
      domain: (r.domain as string | null) ?? null,
      action: (r.action as string | null) ?? null,
      taskSummary: (r.task_summary as string | null) ?? null,
      createdAt: r.created_at as string,
      scope: (r.scope as string | null) ?? null,
      subjects: Array.isArray(subjects) ? subjects.filter((s) => typeof s === "string") : [],
      filesTouched: parse(r.files_touched),
      aiClient: (r.ai_client as string | null) ?? null,
    };
  });
}

export function learningActivityRows(db: Db, workspaceId: string, limit = 200): ActivityLeadSource[] {
  const rows = db
    .prepare(
      "SELECT id, created_at, files_touched, provenance FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(workspaceId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
  const parse = (value: unknown): unknown => {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  };
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    filesTouched: (parse(r.files_touched) ?? {}) as ActivityLeadSource["filesTouched"],
    provenance: normalizeActivityProvenance(parse(r.provenance)),
  }));
}
