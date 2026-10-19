// SPDX-License-Identifier: Apache-2.0
// LocalBackend's memory vector store over its SQLite handle: writing a vector, reading the vectors
// of one space, coverage counts and the re-embedding run. Kept out of local-backend.ts (a tracked
// hotspot); the class delegates here.
//
// Every row's `model` column holds the space key of its vector (embeddingSpaceKey), so vectors of
// two providers or models are never compared, even at one dimension. Rows written before that hold
// the bare model name; canonicalVectorSpace says when one still counts.

import type Database from "better-sqlite3";

import {
  currentEmbeddingSpace,
  embeddingSpaceFamilyLabel,
  EmbeddingHttpError,
  storedVectorInSpace,
  type EmbedFn,
  type EmbedResult,
  type EmbeddingSpaceFamily,
} from "../embedding-adapter.js";
import { composeEmbeddingText, type StoredMemoryVector } from "../semantic-rank.js";
import { blobToVector, vectorToBlob } from "./vector-blob.js";

type Db = InstanceType<typeof Database>;

/** Upsert one memory's vector, stamped with its space. Replaces the row in one statement. */
export function storeMemoryEmbedding(
  db: Db,
  memoryId: string,
  workspaceId: string,
  result: EmbedResult,
  at: string,
): void {
  db.prepare(
    `INSERT INTO memory_embeddings (memory_id, workspace_id, model, dims, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET
       model = excluded.model, dims = excluded.dims,
       embedding = excluded.embedding, created_at = excluded.created_at`,
  ).run(
    memoryId,
    workspaceId,
    result.space ?? result.model,
    result.dims,
    vectorToBlob(result.embedding),
    at,
  );
}

/** The space this workspace's vectors are compared in (currentEmbeddingSpace). */
export function workspaceEmbeddingSpace(
  db: Db,
  workspaceId: string,
  family: EmbeddingSpaceFamily | null,
  fromVectors: boolean,
): { key: string; dims: number } | null {
  const groups = db
    .prepare(
      `SELECT e.model AS model, e.dims AS dims, COUNT(*) AS count
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id AND m.status = 'active'
        WHERE e.workspace_id = ?
        GROUP BY e.model, e.dims`,
    )
    .all(workspaceId) as Array<{ model: string; dims: number; count: number }>;
  return currentEmbeddingSpace(groups, family, fromVectors);
}

/** Active memories' vectors, decoded on demand, for the semantic scan. */
export function memoryVectors(db: Db, workspaceId: string): StoredMemoryVector[] {
  const rows = db
    .prepare(
      `SELECT e.memory_id AS id, e.model AS model, e.dims AS dims, e.embedding AS embedding,
              m.title AS title, COALESCE(n.relative_path, '') AS node_path
         FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id AND m.status = 'active'
         LEFT JOIN nodes n ON n.id = m.node_id
        WHERE e.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{
    id: string;
    model: string;
    dims: number;
    embedding: Buffer;
    title: string;
    node_path: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    node_path: row.node_path,
    model: row.model,
    dims: row.dims,
    vector: () => blobToVector(row.embedding, row.dims),
  }));
}

/** memory id → vector, for the active memories whose vector lies in `space`. */
export function memoryVectorsInSpace(
  db: Db,
  workspaceId: string,
  space: { key: string; dims: number },
): Record<string, number[]> {
  const payload: Record<string, number[]> = {};
  for (const stored of memoryVectors(db, workspaceId)) {
    if (!storedVectorInSpace(stored, space.key, space.dims)) continue;
    const vec = stored.vector();
    if (vec) payload[stored.id] = Array.from(vec); // a truncated/corrupt blob is skipped, never shipped
  }
  return payload;
}

/** How many of a workspace's memories have a vector the current space can use. */
export interface EmbeddingCoverage {
  /** Active memories. */
  memories: number;
  /** With a vector in the current space. */
  current: number;
  /** With a vector of another space only: ignored until re-embedded. */
  stale: number;
  /** With no vector at all. */
  missing: number;
  /** The current space key; null until a vector of the configured space exists. */
  space: string | null;
  /** The configured space short of its dimension; null when no provider is configured. */
  family: string | null;
}

interface MemoryVectorState {
  id: string;
  model: string | null;
  dims: number | null;
}

function memoryVectorStates(db: Db, workspaceId: string, afterId?: string): MemoryVectorState[] {
  return db
    .prepare(
      `SELECT m.id AS id, e.model AS model, e.dims AS dims
         FROM memories m
         LEFT JOIN memory_embeddings e ON e.memory_id = m.id
        WHERE m.workspace_id = ? AND m.status = 'active' AND m.id > ?
        ORDER BY m.id`,
    )
    .all(workspaceId, afterId ?? "") as MemoryVectorState[];
}

function inSpace(state: MemoryVectorState, space: { key: string; dims: number } | null): boolean {
  return (
    space !== null &&
    state.model !== null &&
    state.dims !== null &&
    storedVectorInSpace({ model: state.model, dims: state.dims }, space.key, space.dims)
  );
}

export function embeddingCoverage(
  db: Db,
  workspaceId: string,
  family: EmbeddingSpaceFamily | null,
  fromVectors: boolean,
): EmbeddingCoverage {
  const space = workspaceEmbeddingSpace(db, workspaceId, family, fromVectors);
  const states = memoryVectorStates(db, workspaceId);
  const current = states.filter((s) => inSpace(s, space)).length;
  const missing = states.filter((s) => s.model === null).length;
  return {
    memories: states.length,
    current,
    stale: states.length - current - missing,
    missing,
    space: space?.key ?? null,
    family: family ? embeddingSpaceFamilyLabel(family) : null,
  };
}

/** Where one bounded re-embedding call ended. */
export interface ReindexProgress {
  /** Vectors written by this call. */
  reembedded: number;
  /** Memories whose embedding failed in this call; they stay as they were. */
  failed: number;
  /** Active memories still without a vector in the current space, after this call. */
  remaining: number;
  space: string | null;
  /** The last memory id this call looked at: pass it as `after` to go on from there. */
  cursor: string | null;
  /**
   * Why the call returned: `done` (it reached the last memory), `limit` or `time_budget` (call
   * again with the cursor), or a reason to stop: `not_configured`, `provider_failure` (the provider
   * failed three times running), `space_changed` (the provider answered in another space than the
   * rows it is completing).
   */
  stopped:
    | "done"
    | "limit"
    | "time_budget"
    | "not_configured"
    | "provider_failure"
    | "space_changed";
}

export interface ReindexOptions {
  /** Go on after this memory id (a previous call's cursor). */
  after?: string;
  /** Most memories one call embeds. Default 50. */
  limit?: number;
  /** Start no new embedding after this many ms. Default 15000, so a call ends inside an RPC timeout. */
  budgetMs?: number;
}

/** A provider refusal of one input (it is too long, say) rather than of every call. */
function rowSpecific(err: unknown): boolean {
  return err instanceof EmbeddingHttpError && [400, 413, 422].includes(err.status);
}

/**
 * Re-embed, in memory id order, the active memories whose vector is missing or in another space.
 * Each vector is written on its own as soon as it arrives, replacing the old one in that same
 * statement, so an interrupted run loses nothing and a later run continues where this one stopped
 * (those rows are in the current space now). Only `memory_embeddings` changes. While a run is
 * incomplete, queries compare only vectors of the current space, so an old vector is never used.
 */
export async function reindexMemoryEmbeddings(input: {
  db: Db;
  workspaceId: string;
  embed: EmbedFn;
  family: EmbeddingSpaceFamily | null;
  fromVectors: boolean;
  now: () => string;
  options?: ReindexOptions;
}): Promise<ReindexProgress> {
  const { db, workspaceId } = input;
  const limit = Math.max(1, input.options?.limit ?? 50);
  const deadline = Date.now() + Math.max(0, input.options?.budgetMs ?? 15_000);
  let space = workspaceEmbeddingSpace(db, workspaceId, input.family, input.fromVectors);
  const progress = (
    stopped: ReindexProgress["stopped"],
    counts: { reembedded: number; failed: number; cursor: string | null },
  ): ReindexProgress => ({
    ...counts,
    remaining: memoryVectorStates(db, workspaceId).filter((s) => !inSpace(s, space)).length,
    space: space?.key ?? null,
    stopped,
  });
  const counts = { reembedded: 0, failed: 0, cursor: input.options?.after ?? null };
  if (!input.family && !input.fromVectors) return progress("not_configured", counts);

  let failuresInARow = 0;
  for (const state of memoryVectorStates(db, workspaceId, input.options?.after)) {
    if (inSpace(state, space)) continue;
    if (counts.reembedded + counts.failed >= limit) return progress("limit", counts);
    if (Date.now() >= deadline) return progress("time_budget", counts);
    const memory = db
      .prepare("SELECT title, content FROM memories WHERE id = ? AND status = 'active'")
      .get(state.id) as { title: string; content: string } | undefined;
    if (!memory) {
      counts.cursor = state.id;
      continue;
    }
    let result: EmbedResult | null;
    try {
      result = await input.embed(composeEmbeddingText(memory.title, memory.content), {
        inputType: "document",
      });
    } catch (err) {
      counts.failed += 1;
      counts.cursor = state.id;
      failuresInARow = rowSpecific(err) ? 0 : failuresInARow + 1;
      if (failuresInARow >= 3) return progress("provider_failure", counts);
      continue;
    }
    if (!result) return progress("not_configured", counts);
    const resultSpace = { key: result.space ?? result.model, dims: result.dims };
    if (space && (resultSpace.key !== space.key || resultSpace.dims !== space.dims)) {
      return progress("space_changed", counts);
    }
    space ??= resultSpace;
    storeMemoryEmbedding(db, state.id, workspaceId, result, input.now());
    counts.reembedded += 1;
    counts.cursor = state.id;
    failuresInARow = 0;
  }
  return progress("done", counts);
}
