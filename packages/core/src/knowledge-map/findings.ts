// SPDX-License-Identifier: Apache-2.0
//
// Structural findings, all deterministic and content-free (item ids, similarities,
// link targets). Only consolidate, companion_unlinked and dangling_link become maintenance
// cases (Phase 6); the rest stay candidates until a labelled precision run exists.

import type { KnowledgeMapInput } from "../backend/knowledge-map-input.js";
import { NEAR_DUPLICATE, pairKey, type ContentGraph } from "./graph.js";
import type { KnowledgeRegion, MapFinding, MapItem } from "./types.js";

export const SCOPE_DOWN_SHARE = 0.6;
export const JUNCTION_PARTICIPATION = 0.6;
export const JUNCTION_MIN_REGIONS = 3;
export const JUNCTION_MIN_DEGREE = 6;
const JUNCTION_REGION_SHARE = 0.1;
const NO_REGION = "";

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (x: number): number => Math.round(x * 10_000) / 10_000;

export interface FindingsInput {
  input: KnowledgeMapInput;
  graph: ContentGraph;
  adjacency: Map<string, Map<string, number>>;
  regions: KnowledgeRegion[];
  /** item id -> region id */
  regionOf: Map<string, string>;
  items: Record<string, MapItem>;
  loose: ReadonlySet<string>;
}

function consolidationGroups(graph: ContentGraph): MapFinding[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let node = id; parent.get(node) !== root; ) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const strong = [...graph.vectorPairs.entries()].filter(([, similarity]) => similarity >= NEAR_DUPLICATE).sort((x, y) => byId(x[0], y[0]));
  for (const [key] of strong) {
    const [a, b] = key.split("|") as [string, string];
    for (const id of [a, b]) if (!parent.has(id)) parent.set(id, id);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of [...parent.keys()].sort(byId)) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()]
    .map((members) => {
      const set = new Set(members);
      const maxSimilarity = Math.max(
        ...strong.filter(([key]) => key.split("|").every((id) => set.has(id))).map(([, similarity]) => similarity),
      );
      return { kind: "consolidate" as const, itemIds: members, maxSimilarity: round(maxSimilarity) };
    })
    .sort((x, y) => y.itemIds.length - x.itemIds.length || byId(x.itemIds[0]!, y.itemIds[0]!));
}

function unlinkedCompanions(graph: ContentGraph, items: Record<string, MapItem>): MapFinding[] {
  const out: MapFinding[] = [];
  for (const key of [...graph.lexicalPairs.keys()].sort()) {
    const similarity = graph.lexicalPairs.get(key)!;
    const [a, b] = key.split("|") as [string, string];
    if (similarity < NEAR_DUPLICATE || items[a]?.kind === items[b]?.kind || graph.linkPairs.has(key)) continue;
    out.push({ kind: "companion_unlinked", itemIds: [a, b], similarity: round(similarity) });
  }
  return out;
}

export function mapFindings(f: FindingsInput): MapFinding[] {
  const regionById = new Map(f.regions.map((region) => [region.id, region]));
  const scopeDown: MapFinding[] = [];
  const junctions: MapFinding[] = [];
  for (const id of Object.keys(f.items).sort(byId)) {
    const regionId = f.regionOf.get(id);
    if (!regionId || f.loose.has(id)) continue;
    const ties = new Map<string, number>();
    let total = 0;
    for (const [other, weight] of f.adjacency.get(id) ?? []) {
      const key = f.regionOf.get(other) ?? NO_REGION;
      ties.set(key, (ties.get(key) ?? 0) + weight);
      total += weight;
    }
    if (total === 0) continue;
    const item = f.items[id]!;
    const region = regionById.get(regionId)!;
    const inside = (ties.get(regionId) ?? 0) / total;
    const atRoot = item.nodePaths.length === 0 || item.nodePaths.every((path) => path === "/");
    if (atRoot && inside >= SCOPE_DOWN_SHARE && region.pathFit >= SCOPE_DOWN_SHARE && region.homePath !== "/") {
      scopeDown.push({ kind: "scope_down_candidate", itemId: id, regionId, homePath: region.homePath, share: round(inside) });
    }
    const participation = 1 - [...ties.values()].reduce((sum, weight) => sum + (weight / total) ** 2, 0);
    const touched = [...ties.entries()]
      .filter(([key, weight]) => key !== NO_REGION && weight / total >= JUNCTION_REGION_SHARE)
      .map(([key]) => key)
      .sort(byId);
    if (participation >= JUNCTION_PARTICIPATION && touched.length >= JUNCTION_MIN_REGIONS && (f.adjacency.get(id)?.size ?? 0) >= JUNCTION_MIN_DEGREE) {
      junctions.push({ kind: "junction", itemId: id, regionIds: touched, participation: round(participation) });
    }
  }
  const unused: MapFinding[] =
    f.input.usage === null
      ? []
      : Object.values(f.items)
          .filter((item) => item.sessions === 0)
          .map((item) => ({ kind: "unused" as const, itemId: item.id, windowDays: f.input.usageWindowDays ?? 0 }))
          .sort((x, y) => byId(x.itemId, y.itemId));
  const dangling: MapFinding[] = f.graph.dangling.map((d) => ({ kind: "dangling_link" as const, itemId: d.itemId, target: d.target }));
  return [...consolidationGroups(f.graph), ...unlinkedCompanions(f.graph, f.items), ...dangling, ...scopeDown, ...junctions, ...unused];
}

/** Findings that mention an item, for region pages and related lookups. */
export function findingsFor(findings: readonly MapFinding[], ids: ReadonlySet<string>): MapFinding[] {
  return findings.filter((finding) =>
    "itemIds" in finding ? finding.itemIds.some((id) => ids.has(id)) : ids.has(finding.itemId),
  );
}

export { pairKey };
