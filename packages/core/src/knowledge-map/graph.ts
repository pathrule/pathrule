// SPDX-License-Identifier: Apache-2.0
//
// Content edges between knowledge items (plan D1). Two layers, never the folder tree:
//   link      resolved [[target]] and ::skill references, weight min(1.5, count)
//   semantic  vector neighbours own memory pairs; lexical (TF-IDF + CSLS, mapped onto the
//             vector scale) owns every pair touching a rule or skill, and every pair when the
//             workspace has no vectors. Weight (similarity - 0.5) / 0.5 for similarity >= 0.60.
// Ported from the knowledge-map prototype; its numbers are the baseline.

import type { KnowledgeMapInput, KnowledgeMapItemInput } from "../backend/knowledge-map-input.js";
import { createLinkResolver, extractLinkTargets, type LinkStage } from "./links.js";
import {
  buildLexicalIndex,
  knotScale,
  lexicalNeighbourLists,
  quantileScale,
  type ScoredNeighbour,
} from "./lexical.js";
import type { MapEdge, MapEdgeKind } from "./types.js";

export const SEMANTIC_MIN = 0.6;
export const SEMANTIC_K = 6;
export const NEAR_DUPLICATE = 0.85;
export const LINK_WEIGHT_CAP = 1.5;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface ContentGraph {
  edges: MapEdge[];
  /** pair key -> link count (one per distinct target string per item). */
  linkPairs: Map<string, number>;
  /** pair key -> vector similarity, memory pairs at or above SEMANTIC_MIN. */
  vectorPairs: Map<string, number>;
  /** pair key -> lexical similarity on the vector scale, at or above SEMANTIC_MIN. */
  lexicalPairs: Map<string, number>;
  dangling: Array<{ itemId: string; target: string }>;
  links: { resolved: number; byStage: Record<LinkStage, number>; dangling: number };
}

export function itemText(item: KnowledgeMapItemInput): string {
  return `${item.description ?? ""} ${item.body}`;
}

function linkLayer(items: readonly KnowledgeMapItemInput[]) {
  const resolver = createLinkResolver(items.map((item) => ({ id: item.id, kind: item.kind, title: item.title })));
  const linkPairs = new Map<string, number>();
  const byStage: Record<LinkStage, number> = { exact: 0, apostrophe: 0, punctuation: 0, prefix: 0, subset: 0 };
  const dangling: Array<{ itemId: string; target: string }> = [];
  let resolved = 0;
  for (const item of items) {
    for (const target of extractLinkTargets(`${item.body}\n${item.description ?? ""}`)) {
      const hit = resolver.resolve(target);
      if (!hit) {
        // An unknown ::name is usually not a skill at all (::before, ::uuid), so only
        // [[...]] links count as dangling.
        if (!target.startsWith("::")) dangling.push({ itemId: item.id, target });
        continue;
      }
      if (hit.id === item.id) continue;
      resolved++;
      byStage[hit.stage]++;
      const key = pairKey(item.id, hit.id);
      linkPairs.set(key, (linkPairs.get(key) ?? 0) + 1);
    }
  }
  return { linkPairs, dangling, links: { resolved, byStage, dangling: dangling.length } };
}

function vectorLayer(input: KnowledgeMapInput, ids: ReadonlySet<string>) {
  const lists = new Map<string, ScoredNeighbour[]>();
  for (const [a, b, similarity] of input.neighbours) {
    if (!ids.has(a) || !ids.has(b) || a === b) continue;
    const list = lists.get(a);
    if (list) list.push([b, similarity]);
    else lists.set(a, [[b, similarity]]);
  }
  const pairs = new Map<string, number>();
  const topScores: number[] = [];
  for (const id of [...lists.keys()].sort(byId)) {
    const top = lists.get(id)!.sort((x, y) => y[1] - x[1] || byId(x[0], y[0])).slice(0, SEMANTIC_K);
    for (const [other, similarity] of top) {
      topScores.push(similarity);
      if (similarity < SEMANTIC_MIN) continue;
      const key = pairKey(id, other);
      pairs.set(key, Math.max(pairs.get(key) ?? 0, similarity));
    }
  }
  return { pairs, topScores: topScores.sort((x, y) => x - y) };
}

export function buildContentGraph(input: KnowledgeMapInput): ContentGraph {
  const items = [...input.items].sort((a, b) => byId(a.id, b.id));
  const ids = new Set(items.map((item) => item.id));
  const kindOf = new Map(items.map((item) => [item.id, item.kind]));
  const memoryIds = items.filter((item) => item.kind === "memory").map((item) => item.id);

  const { linkPairs, dangling, links } = linkLayer(items);
  const vectors = input.semantic === "lexical" ? null : vectorLayer(input, ids);
  const hasVectors = vectors !== null && vectors.pairs.size + vectors.topScores.length > 0;

  // CSLS picks each item's lexical neighbours (no hubs); the cosine of a picked pair, mapped
  // onto the vector scale, is its similarity.
  const index = buildLexicalIndex(items.map((item) => ({ id: item.id, title: item.title, text: itemText(item) })));
  const allLists = lexicalNeighbourLists(index, [...ids], SEMANTIC_K);
  let toVectorScale: (cosine: number) => number = (cosine) => knotScale(cosine);
  if (hasVectors) {
    const memoryLists = lexicalNeighbourLists(index, memoryIds, SEMANTIC_K);
    const lexicalTop = [...memoryLists.values()]
      .flatMap((list) => list.slice(0, SEMANTIC_K).map((n) => n.cosine))
      .sort((x, y) => x - y);
    toVectorScale = quantileScale(lexicalTop, vectors!.topScores);
  }
  const lexicalPairs = new Map<string, number>();
  for (const id of [...ids].sort(byId)) {
    for (const { id: other, cosine } of allLists.get(id)!.slice(0, SEMANTIC_K)) {
      const similarity = toVectorScale(cosine);
      if (similarity < SEMANTIC_MIN) continue;
      if (hasVectors && kindOf.get(id) === "memory" && kindOf.get(other) === "memory") continue;
      const key = pairKey(id, other);
      lexicalPairs.set(key, Math.max(lexicalPairs.get(key) ?? 0, similarity));
    }
  }
  const vectorPairs = hasVectors ? vectors!.pairs : new Map<string, number>();

  const merged = new Map<string, { weight: number; kinds: Set<MapEdgeKind>; similarity?: number }>();
  const add = (key: string, weight: number, kind: MapEdgeKind, similarity?: number): void => {
    const edge = merged.get(key) ?? { weight: 0, kinds: new Set<MapEdgeKind>() };
    edge.weight += weight;
    edge.kinds.add(kind);
    if (similarity !== undefined) edge.similarity = Math.max(edge.similarity ?? 0, similarity);
    merged.set(key, edge);
  };
  for (const key of [...linkPairs.keys()].sort()) add(key, Math.min(LINK_WEIGHT_CAP, linkPairs.get(key)!), "link");
  for (const source of [vectorPairs, lexicalPairs]) {
    for (const key of [...source.keys()].sort()) {
      const similarity = source.get(key)!;
      add(key, (similarity - 0.5) / 0.5, "semantic", similarity);
    }
  }
  const edges: MapEdge[] = [...merged.keys()].sort().map((key) => {
    const [a, b] = key.split("|") as [string, string];
    const edge = merged.get(key)!;
    return {
      a,
      b,
      weight: edge.weight,
      kinds: [...edge.kinds].sort(),
      ...(edge.similarity !== undefined ? { similarity: edge.similarity } : {}),
    };
  });
  return { edges, linkPairs, vectorPairs, lexicalPairs, dangling, links };
}
