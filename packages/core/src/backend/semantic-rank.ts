// SPDX-License-Identifier: Apache-2.0
// Pure local semantic ranking + candidate shaping.
//
// Pure (no SQLite, no network deps) so the SQLite-backed and in-memory backends
// share it — same placement as project-map-rank / co-change-rank / briefing.
// The one embedding call of a scan goes through the EmbedFn the backend passes in.
//
// Shapes scored candidates via confidence tiers, lexical-overlap marking,
// direct-id dedup, and a top-N cap. The output is the canonical
// `SemanticCandidatesPayload` shape from @pathrule/shared, so the AI client sees
// an identical `semantic_candidates` field.

import type {
  SemanticCandidateOut,
  SemanticCandidatesPayload,
  SemanticCandidatesResult,
  SemanticQuery,
  SubtreeMemoryIndexResult,
} from "@pathrule/protocol/routing-types.js";

import { storedVectorInSpace, type EmbedFn, type EmbedResult } from "./embedding-adapter.js";

// Thresholds match the documented canonical values so the field reads the same
// across editions.
export const SEMANTIC_CONFIDENCE_HIGH_MIN = 0.78;
export const SEMANTIC_CONFIDENCE_MEDIUM_MIN = 0.5;
export const SEMANTIC_CANDIDATES_MAX = 5;
export const SEMANTIC_SCAN_TOP_K = 10;
export const SEMANTIC_QUERY_MIN_SIMILARITY = 0.45;

/** A memory scored against the query embedding, before confidence shaping. */
export interface ScoredCandidate {
  id: string;
  title: string;
  node_path: string;
  similarity: number;
}

/** Lexical surface ids the agent already saw — used to dedup / mark agreement. */
export interface LexicalIds {
  /** Direct memory ids (already shown with bodies) — dropped from candidates. */
  direct: Set<string>;
  /** Subtree + discovery title-only ids — kept with lexical_overlap=true. */
  titleOnly: Set<string>;
}

export function collectLexicalIds(input: {
  bundleMemories: Array<{ id: string }> | undefined;
  subtreeIndex: SubtreeMemoryIndexResult | undefined;
  discoveryCandidateTitles: Array<{ id: string }> | undefined;
}): LexicalIds {
  const direct = new Set<string>();
  for (const m of input.bundleMemories ?? []) {
    if (m && typeof m.id === "string") direct.add(m.id);
  }
  const titleOnly = new Set<string>();
  for (const e of input.subtreeIndex?.entries ?? []) {
    if (e && typeof e.id === "string") titleOnly.add(e.id);
  }
  for (const c of input.discoveryCandidateTitles ?? []) {
    if (c && typeof c.id === "string") titleOnly.add(c.id);
  }
  return { direct, titleOnly };
}

/** Cosine similarity of two equal-length numeric vectors. 0 for a zero vector. */
// Accepts ArrayLike so callers can pass a Float32Array view straight off a stored
// blob without copying it into a plain array first.
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // A non-finite element in a stored vector (corrupt/hand-edited DB row) would
  // propagate NaN/Infinity here; clamp to 0 so a bad vector never out-ranks a
  // real match or leaks NaN into the emitted similarity score.
  return Number.isFinite(sim) ? sim : 0;
}

/** Deterministic embedded-text composer shared by the on-write embed path. */
export function composeEmbeddingText(title: string, content: string): string {
  const summary = (content ?? "").replace(/\s+/g, " ").trim().slice(0, 1600);
  return `Title: ${title}\nSummary: ${summary}`;
}

// Relevance-routed body injection. The hook ranks a path's memory/skill
// candidates against the prompt embedding and injects only the top-k full
// bodies. Default 8 for completeness: a multi-part prompt needs several
// relevant bodies at once, and the cosine floor below already filters noise, so
// a too-small top-k leaves the agent exploring for the missing facts (the
// dominant end-to-end cost). The floor, not k, is what abstains on a weak match.
export const SEMANTIC_INJECT_TOPK = 8;
// Query↔document cosine for RELEVANT pairs sits ~0.50–0.65 (measured on Voyage
// voyage-3 query/document embeddings), so the floor matches the established
// SEMANTIC_QUERY_MIN_SIMILARITY (0.45): relevant items pass, noise is dropped. A
// higher floor (e.g. 0.62) silently cuts true matches and forces a lexical
// fallback — i.e. the semantic ranker never actually fires.
export const SEMANTIC_INJECT_MIN = 0.45;

/** One ranked item: an id and its cosine score against the prompt. */
export interface RankedItem {
  id: string;
  score: number;
}

/**
 * Rank candidate items by cosine similarity to the prompt vector and return the
 * top-k above `minCosine`. PURE: no I/O, deterministic. Ordering is
 * score-descending with a stable tie-break by id, so an unchanged candidate set
 * + prompt vector always yields byte-identical selection (the cache-stability
 * invariant the hook relies on). Items missing an id or vector are skipped; a
 * mismatched/zero vector scores 0 (via `cosineSimilarity`) and is dropped by the
 * threshold.
 */
export function rankByPromptSimilarity(input: {
  promptVec: ArrayLike<number>;
  items: Array<{ id: string; vec: ArrayLike<number> }>;
  topK?: number;
  minCosine?: number;
}): RankedItem[] {
  const topK = input.topK ?? SEMANTIC_INJECT_TOPK;
  const minCosine = input.minCosine ?? SEMANTIC_INJECT_MIN;
  const scored: RankedItem[] = [];
  for (const item of input.items ?? []) {
    if (!item || typeof item.id !== "string" || !item.vec) continue;
    const score = cosineSimilarity(input.promptVec, item.vec);
    if (score < minCosine) continue;
    scored.push({ id: item.id, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return scored.slice(0, Math.max(0, topK));
}

/**
 * Shape scored candidates into the additive `semantic_candidates` payload:
 * similarity-descending, drop direct (already-shown) ids, mark lexical overlap
 * as high-confidence agreement, apply HIGH/MEDIUM tiers, drop low-confidence,
 * cap at MAX. Returns undefined when nothing survives (caller emits
 * `no_candidates`).
 */
export function shapeLocalSemanticCandidates(input: {
  scored: ScoredCandidate[];
  lexical: LexicalIds;
  matchedNodePath: string;
  model: string;
  limit: number;
  minSimilarity: number;
  outputMax?: number;
  /** Lowers both confidence tiers, for a model whose cosine scale sits below the default one. */
  tierShift?: number;
}): SemanticCandidatesPayload | undefined {
  const max = input.outputMax ?? SEMANTIC_CANDIDATES_MAX;
  const shift = input.tierShift ?? 0;
  const sorted = [...input.scored].sort((a, b) => b.similarity - a.similarity);
  const seen = new Set<string>();
  const out: SemanticCandidateOut[] = [];

  for (const cand of sorted) {
    if (out.length >= max) break;
    if (!cand || typeof cand.id !== "string") continue;
    if (seen.has(cand.id)) continue;
    if (input.lexical.direct.has(cand.id)) continue; // already shown with body

    const overlap = input.lexical.titleOnly.has(cand.id);
    // Guard against a non-finite score (NaN survives a `typeof === "number"` check
    // and would serialize as `null` in the emitted payload, and a lexical-overlap
    // candidate is force-promoted to "high" before any similarity tier check).
    const sim = Number.isFinite(cand.similarity) ? cand.similarity : 0;

    let confidence: "high" | "medium" | null = null;
    if (overlap || sim >= SEMANTIC_CONFIDENCE_HIGH_MIN - shift) confidence = "high";
    else if (sim >= SEMANTIC_CONFIDENCE_MEDIUM_MIN - shift) confidence = "medium";
    if (confidence === null) continue; // low-confidence: dropped by design

    seen.add(cand.id);
    out.push({
      id: cand.id,
      title: cand.title,
      node_path: cand.node_path,
      similarity: Number(sim.toFixed(4)),
      source: "semantic",
      confidence,
      ...(overlap ? { lexical_overlap: true } : {}),
      reason: overlap
        ? "lexical_and_vector_overlap"
        : confidence === "high"
          ? "high_similarity"
          : "medium_similarity",
    });
  }

  if (out.length === 0) return undefined;
  return {
    candidates: out,
    model: input.model,
    searched_scope: {
      matched_node_path: input.matchedNodePath,
      limit: input.limit,
      min_similarity: input.minSimilarity,
    },
  };
}

/** One stored memory vector and what its candidate shows. `vector` decodes it on demand. */
export interface StoredMemoryVector {
  id: string;
  title: string;
  node_path: string;
  /** The stored space (the `model` column): a space key, or a legacy bare model name. */
  model: string;
  dims: number;
  vector(): ArrayLike<number> | null;
}

/**
 * Embed the query and score stored memory vectors against it, then shape the payload. Shared by
 * both backends so they stay shape-identical. Only vectors in the query's space are compared, so a
 * provider switch never ranks one model's vectors against another's, however equal their
 * dimensions. A model with its own cosine floor (EmbedResult.minSimilarity) gets that floor unless
 * the caller set one, and the confidence tiers move down with it; every other model keeps today's.
 * `null` ⇒ the seam is unwired.
 */
export async function semanticCandidatesOverVectors(input: {
  query: SemanticQuery;
  embed: EmbedFn;
  vectors: () => Iterable<StoredMemoryVector>;
}): Promise<SemanticCandidatesResult | null> {
  const start = Date.now();
  const { query } = input;
  const intent = query.userIntent.trim();
  if (intent.length === 0) return { payload: undefined, skipped: "empty_intent" };

  let queryEmbedding: EmbedResult | null;
  try {
    queryEmbedding = await input.embed(intent, { inputType: "query" });
  } catch {
    return { payload: undefined, skipped: "provider_failure", latencyMs: Date.now() - start };
  }
  if (!queryEmbedding) return null;

  const space = queryEmbedding.space ?? queryEmbedding.model;
  const modelFloor = queryEmbedding.minSimilarity;
  const minSimilarity = query.minSimilarity ?? modelFloor ?? SEMANTIC_QUERY_MIN_SIMILARITY;
  const scored: ScoredCandidate[] = [];
  for (const stored of input.vectors()) {
    if (!storedVectorInSpace(stored, space, queryEmbedding.dims)) continue;
    const vector = stored.vector();
    if (!vector) continue; // a truncated or corrupt blob is skipped, never scored
    const similarity = cosineSimilarity(queryEmbedding.embedding, vector);
    if (similarity < minSimilarity) continue;
    scored.push({ id: stored.id, title: stored.title, node_path: stored.node_path, similarity });
  }

  const limit = query.limit ?? SEMANTIC_SCAN_TOP_K;
  const payload = shapeLocalSemanticCandidates({
    scored,
    lexical: collectLexicalIds({
      bundleMemories: query.bundleMemories,
      subtreeIndex: query.subtreeIndex,
      discoveryCandidateTitles: query.discoveryCandidateTitles,
    }),
    matchedNodePath: query.matchedNodePath,
    model: queryEmbedding.model,
    limit,
    minSimilarity,
    ...(modelFloor === undefined ? {} : { tierShift: SEMANTIC_QUERY_MIN_SIMILARITY - modelFloor }),
  });

  return {
    payload,
    skipped: payload ? undefined : "no_candidates",
    latencyMs: Date.now() - start,
  };
}

/**
 * Add each skill's vector to an embeddings payload, embedded now (skills are few per workspace and
 * have no vector store). Only a vector in `space` joins: the payload holds one space. Best-effort:
 * a failed embed drops that skill from the ranking pool and never fails the payload.
 */
export async function addSkillVectors(
  payload: Record<string, number[]>,
  skills: Iterable<{ id: string; name: string; content: string }>,
  embed: EmbedFn,
  space: { key: string; dims: number },
): Promise<void> {
  for (const skill of skills) {
    try {
      const r = await embed(composeEmbeddingText(skill.name, skill.content), {
        inputType: "document",
      });
      if (r && r.dims === space.dims && (r.space ?? r.model) === space.key)
        payload[skill.id] = r.embedding;
    } catch {
      /* best-effort: skip this skill */
    }
  }
}
