// SPDX-License-Identifier: Apache-2.0
// What a folder's Pathrule Local workspace logged, read without opening its store for writing, for a
// person who copies it elsewhere (`pathrule activity import --from-local`). Only the rows of the
// workspace that serves the folder are read: a store can hold rows of another workspace id.

import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { pathruleHome } from "../../storage/paths.js";
import { discoverWorkspaceStoreForCwd } from "./workspace-stores.js";

/** The Local workspace that serves a folder, and its root folder. */
export interface LocalActivitySource {
  workspaceId: string;
  root: string;
}

/** One `activity_logs` row, its JSON columns parsed (null when a value cannot be read). */
export interface LocalActivityRow {
  id: string;
  nodePath: string | null;
  domain: string | null;
  action: string | null;
  scope: string | null;
  subjects: unknown;
  taskSummary: string | null;
  filesTouched: unknown;
  aiClient: string | null;
  provenance: unknown;
  createdAt: string;
}

function storePath(workspaceId: string, env: NodeJS.ProcessEnv): string {
  return join(pathruleHome(env), workspaceId, "pathrule.db");
}

/** The Local workspace serving `cwd` (never a mirror of a hosted one), or null. */
export function localActivitySourceFor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalActivitySource | null {
  const match = discoverWorkspaceStoreForCwd(cwd, env);
  if (!match || !existsSync(storePath(match.workspaceId, env))) return null;
  return { workspaceId: match.workspaceId, root: match.localRootPath };
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The workspace's entries created at or after `sinceIso`, oldest first. */
export function readLocalActivity(
  source: LocalActivitySource,
  sinceIso: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalActivityRow[] {
  const db = new Database(storePath(source.workspaceId, env), { readonly: true, fileMustExist: true });
  try {
    // `provenance` arrived with a later schema; an older store answers without it.
    const columns = new Set(
      (db.prepare("PRAGMA table_info(activity_logs)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    const provenance = columns.has("provenance") ? "provenance" : "NULL AS provenance";
    const rows = db
      .prepare(
        `SELECT id, node_path, domain, action, scope, subjects, task_summary, files_touched, ai_client, ${provenance}, created_at FROM activity_logs WHERE workspace_id = ? AND created_at >= ? ORDER BY created_at, rowid`,
      )
      .all(source.workspaceId, sinceIso) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      nodePath: text(r.node_path),
      domain: text(r.domain),
      action: text(r.action),
      scope: text(r.scope),
      subjects: json(r.subjects),
      taskSummary: text(r.task_summary),
      filesTouched: json(r.files_touched),
      aiClient: text(r.ai_client),
      provenance: json(r.provenance),
      createdAt: String(r.created_at),
    }));
  } finally {
    db.close();
  }
}
