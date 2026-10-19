// SPDX-License-Identifier: Apache-2.0
// LocalBackend's knowledge map input and fingerprint, over its SQLite handle. Kept out
// of local-backend.ts (a tracked hotspot); the class delegates here in one line each.
//
// Vector neighbours are exact top-12 cosine per memory over the on-write embedding store,
// computed here because SQLite has no vector operator. Quadratic, so it runs only between 2
// and LOCAL_VECTOR_CAP vectors of one space (1,000 x 1,024 dims is about a billion
// multiply-adds, around a second); otherwise the map uses lexical similarity and says so.
// The local edition records no hook injections, so usage is null.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalVectorSpace } from "../embedding-adapter.js";
import type { KnowledgeMapInput, KnowledgeMapItemInput } from "../knowledge-map-input.js";
import { blobToVector } from "./vector-blob.js";

type Db = InstanceType<typeof Database>;

export const LOCAL_VECTOR_CAP = 1_000;
export const LOCAL_NEIGHBOURS = 12;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function items(db: Db, workspaceId: string): KnowledgeMapItemInput[] {
  const memories = db
    .prepare(
      `SELECT m.id, m.title, m.content, m.updated_at, n.relative_path
         FROM memories m JOIN nodes n ON n.id = m.node_id
        WHERE m.workspace_id = ? AND m.status = 'active' AND n.orphaned_at IS NULL`,
    )
    .all(workspaceId) as Array<{ id: string; title: string; content: string; updated_at: string; relative_path: string }>;
  const attached = <T extends { id: string; relative_path: string }>(rows: T[]): Map<string, { row: T; paths: string[] }> => {
    const out = new Map<string, { row: T; paths: string[] }>();
    for (const row of rows) {
      const entry = out.get(row.id);
      if (entry) entry.paths.push(row.relative_path);
      else out.set(row.id, { row, paths: [row.relative_path] });
    }
    return out;
  };
  const rules = attached(
    db
      .prepare(
        `SELECT r.id, r.name, r.content, r.updated_at, n.relative_path
           FROM rules r JOIN node_rules nr ON nr.rule_id = r.id JOIN nodes n ON n.id = nr.node_id
          WHERE r.workspace_id = ? AND r.status = 'active' AND n.orphaned_at IS NULL`,
      )
      .all(workspaceId) as Array<{ id: string; name: string; content: string; updated_at: string; relative_path: string }>,
  );
  const skills = attached(
    db
      .prepare(
        `SELECT s.id, s.name, s.description, s.content, s.updated_at, n.relative_path
           FROM skills s JOIN node_skills ns ON ns.skill_id = s.id AND ns.is_active = 1 JOIN nodes n ON n.id = ns.node_id
          WHERE s.workspace_id = ? AND s.status = 'active' AND n.orphaned_at IS NULL`,
      )
      .all(workspaceId) as Array<{ id: string; name: string; description: string | null; content: string; updated_at: string; relative_path: string }>,
  );
  const sortedPaths = (paths: string[]): string[] => [...new Set(paths)].sort(byId);
  return [
    ...memories.map((m) => ({
      id: m.id,
      kind: "memory" as const,
      title: m.title,
      description: null,
      body: m.content,
      nodePaths: [m.relative_path],
      updatedAt: m.updated_at,
    })),
    ...[...rules.values()].map(({ row, paths }) => ({
      id: row.id,
      kind: "rule" as const,
      title: row.name,
      description: null,
      body: row.content,
      nodePaths: sortedPaths(paths),
      updatedAt: row.updated_at,
    })),
    ...[...skills.values()].map(({ row, paths }) => ({
      id: row.id,
      kind: "skill" as const,
      title: row.name,
      description: row.description,
      body: row.content,
      nodePaths: sortedPaths(paths),
      updatedAt: row.updated_at,
    })),
  ].sort((a, b) => byId(a.id, b.id));
}

/**
 * Exact top-k cosine neighbours over the vectors of the most common space: one model's vectors
 * are never compared with another's, even at one dimension (`space` unset: dimension alone).
 */
export function vectorNeighbours(
  vectors: ReadonlyArray<{ id: string; vector: Float32Array; space?: string }>,
  k = LOCAL_NEIGHBOURS,
): Array<[string, string, number]> {
  const bySpace = new Map<string, Array<{ id: string; vector: Float32Array }>>();
  for (const entry of vectors) {
    const key = `${entry.space ?? ""}@${entry.vector.length}`;
    const list = bySpace.get(key);
    if (list) list.push(entry);
    else bySpace.set(key, [entry]);
  }
  const pool = [...bySpace.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (pool.length < 2 || pool.length > LOCAL_VECTOR_CAP) return [];
  const sorted = [...pool].sort((a, b) => byId(a.id, b.id));
  const unit = sorted.map(({ vector }) => {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!;
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    return Float32Array.from(vector, (x) => x * scale);
  });
  const out: Array<[string, string, number]> = [];
  for (let a = 0; a < sorted.length; a++) {
    const scores: Array<[number, number]> = [];
    for (let b = 0; b < sorted.length; b++) {
      if (a === b) continue;
      let dot = 0;
      const va = unit[a]!;
      const vb = unit[b]!;
      for (let i = 0; i < va.length; i++) dot += va[i]! * vb[i]!;
      scores.push([b, dot]);
    }
    scores.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    for (const [b, score] of scores.slice(0, k)) out.push([sorted[a]!.id, sorted[b]!.id, Math.round(score * 10_000) / 10_000]);
  }
  return out;
}

export function localKnowledgeMapInput(db: Db, workspaceId: string): KnowledgeMapInput {
  const rows = db
    .prepare(
      `SELECT e.memory_id AS id, e.model AS model, e.dims AS dims, e.embedding AS embedding
         FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id AND m.status = 'active'
        WHERE e.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ id: string; model: string; dims: number; embedding: Buffer }>;
  const vectors = rows.flatMap((row) => {
    const vector = blobToVector(row.embedding, row.dims);
    return vector ? [{ id: row.id, vector, space: canonicalVectorSpace(row) }] : [];
  });
  const neighbours = vectorNeighbours(vectors);
  return {
    workspaceId,
    items: items(db, workspaceId),
    neighbours,
    semantic: neighbours.length > 0 ? "local" : "lexical",
    usage: null,
    usageWindowDays: null,
  };
}

/** Changes whenever localKnowledgeMapInput would: per-row versions, attachments, vectors, paths. */
export function localKnowledgeMapFingerprint(db: Db, workspaceId: string): string {
  const hash = createHash("sha256");
  const add = (sql: string): void => {
    for (const row of db.prepare(sql).all(workspaceId) as Array<Record<string, unknown>>) {
      hash.update(Object.values(row).map((value) => String(value ?? "")).join("/"));
      hash.update("\n");
    }
    hash.update("|");
  };
  add(`SELECT id, node_id, version_id, updated_at FROM memories WHERE workspace_id = ? AND status = 'active' ORDER BY id`);
  add(`SELECT id, version_id, updated_at FROM rules WHERE workspace_id = ? AND status = 'active' ORDER BY id`);
  add(`SELECT id, version_id, updated_at FROM skills WHERE workspace_id = ? AND status = 'active' ORDER BY id`);
  add(`SELECT nr.node_id, nr.rule_id FROM node_rules nr JOIN rules r ON r.id = nr.rule_id WHERE r.workspace_id = ? ORDER BY nr.node_id, nr.rule_id`);
  add(`SELECT ns.node_id, ns.skill_id FROM node_skills ns JOIN skills s ON s.id = ns.skill_id WHERE s.workspace_id = ? AND ns.is_active = 1 ORDER BY ns.node_id, ns.skill_id`);
  add(`SELECT COUNT(*), MAX(created_at) FROM memory_embeddings WHERE workspace_id = ?`);
  add(`SELECT COUNT(*), MAX(updated_at) FROM nodes WHERE workspace_id = ? AND orphaned_at IS NULL`);
  return hash.digest("hex").slice(0, 32);
}
