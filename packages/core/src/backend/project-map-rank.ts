// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic fuzzy project-map ranking. Shared by the SQLite-backed and
 * in-memory backends.
 *
 * Ranks every content-bearing node by a trigram word-similarity between the
 * query and each weighted field (path 1.0, name 0.95, memory/rule/skill names
 * 0.9, body 0.3), keeps matches ≥ 0.30 (post-weight), classifies match_source,
 * and rounds relevance to two decimals.
 *
 * Similarity note: word_similarity scores the query's trigram set against the
 * best *continuous extent* of the target. We approximate that with "fraction of
 * the query's trigrams present anywhere in the target" — identical when the
 * match concentrates in one word (the common case: a query token that is a
 * path/title word scores ~1.0), and only slightly more generous (higher recall)
 * when query trigrams scatter across the target. Exact equivalence is not
 * required: the contract suite asserts shape + behavior against both backends.
 */
import type { NodeBrief, ProjectMapSearchResult } from "@pathrule/protocol/intelligence-types.js";

/** A content-bearing node assembled by a backend, ready to be scored against a query. */
export interface ProjectMapCandidate {
  node_id: string;
  path: string;
  name: string;
  memory_titles: string[];
  rule_names: string[];
  skill_names: string[];
  /** Concatenation of the node's memory/rule/skill bodies, first 400 chars. */
  body_preview: string;
}

/** Post-weight relevance cutoff. */
export const FUZZY_RELEVANCE_THRESHOLD = 0.3;
const DEFAULT_LIMIT = 15;

/** Trigrams: lowercase, split on non-alphanumerics, pad each word " word ". */
function trigramSet(value: string): Set<string> {
  const set = new Set<string>();
  const words = value.toLowerCase().match(/[a-z0-9]+/g);
  if (!words) return set;
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

/** Trigram word-similarity between query and target — see the note above. */
function wordSimilarity(query: string, target: string): number {
  const q = trigramSet(query);
  if (q.size === 0) return 0;
  const t = trigramSet(target);
  if (t.size === 0) return 0;
  let shared = 0;
  for (const gram of q) {
    if (t.has(gram)) shared += 1;
  }
  return shared / q.size;
}

function maxSimilarity(query: string, values: string[]): number {
  let best = 0;
  for (const value of values) {
    const s = wordSimilarity(query, value);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Rank candidates against a query using the field weighting/threshold/classification above.
 * Returns nodes sorted by descending relevance (rounded to 2dp) plus the top raw score.
 */
export function rankProjectMap(
  candidates: ProjectMapCandidate[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): ProjectMapSearchResult {
  if (!query || query.trim().length === 0) return { nodes: [], topScore: 0 };
  const effectiveLimit = limit > 0 ? limit : DEFAULT_LIMIT;

  const scored: Array<{ brief: NodeBrief; best: number }> = [];
  let topScore = 0;

  for (const c of candidates) {
    const sPath = wordSimilarity(query, c.path) * 1.0;
    const sName = wordSimilarity(query, c.name) * 0.95;
    const sMem = maxSimilarity(query, c.memory_titles) * 0.9;
    const sRule = maxSimilarity(query, c.rule_names) * 0.9;
    const sSkill = maxSimilarity(query, c.skill_names) * 0.9;
    const sBody = wordSimilarity(query, c.body_preview) * 0.3;
    const best = Math.max(sPath, sName, sMem, sRule, sSkill, sBody);
    if (best < FUZZY_RELEVANCE_THRESHOLD) continue;
    if (best > topScore) topScore = best;
    const nonBodyBest = Math.max(sPath, sName, sMem, sRule, sSkill);
    const matchSource: NodeBrief["match_source"] =
      sBody > 0 && sBody >= nonBodyBest ? "body_preview" : "fuzzy";
    scored.push({
      best,
      brief: {
        node_id: c.node_id,
        path: c.path,
        name: c.name,
        memory_titles: c.memory_titles,
        rule_names: c.rule_names,
        skill_names: c.skill_names,
        match_source: matchSource,
        relevance: Math.round(best * 100) / 100,
      },
    });
  }

  scored.sort((a, b) => b.best - a.best);
  return { nodes: scored.slice(0, effectiveLimit).map((s) => s.brief), topScore };
}
