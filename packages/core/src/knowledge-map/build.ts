// SPDX-License-Identifier: Apache-2.0
//
// Knowledge map assembly. Content edges -> two-level deterministic partition -> regions
// with stable ids, path homes for items no content edge reaches, and structural findings.
// Pure and synchronous; the same input always yields a deep-equal map (plan D3).

import type { KnowledgeMapInput, KnowledgeMapItemInput } from "../backend/knowledge-map-input.js";
import { stableHash } from "@pathrule/protocol/versioning.js";
import { extractPathAnchors, resolveItemAnchors } from "./anchors.js";
import { buildContentGraph, type ContentGraph } from "./graph.js";
import { tokenize } from "./lexical.js";
import { mapFindings } from "./findings.js";
import { partition } from "./partition.js";
import {
  KNOWLEDGE_MAP_ALGORITHM,
  type KnowledgeMap,
  type KnowledgeRegion,
  type KnowledgeSubRegion,
  type MapItem,
} from "./types.js";

export const MIN_REGION = 3;
export const SUBREGION_MIN_ITEMS = 25;
const ONE_LINER_MAX = 110;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const charsOf = (item: KnowledgeMapItemInput): number => item.body.length + (item.description?.length ?? 0);

export function normalizeNodePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The item's home node: its first node path in sorted order, "/" when it has none. */
export function primaryPath(item: Pick<KnowledgeMapItemInput, "nodePaths">): string {
  const paths = item.nodePaths.map(normalizeNodePath).sort(byId);
  return paths[0] ?? "/";
}

/** Folder-level area of a path: its first two segments ("/packages/app/src" -> "/packages/app"). */
export function pathArea(path: string): string {
  const segments = normalizeNodePath(path).split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.slice(0, 2).join("/")}`;
}

/** First line of prose in a body, markdown stripped, at most 110 chars. */
export function oneLiner(body: string | null | undefined): string {
  for (const raw of (body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || /^(#|---|```|name:|description:|metadata:|type:)/.test(line)) continue;
    const clean = line.replace(/[*_`>[\]]/g, "").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "");
    if (clean.length < 12) continue;
    return clean.length <= ONE_LINER_MAX ? clean : `${clean.slice(0, ONE_LINER_MAX - 1).trimEnd()}…`;
  }
  return "";
}

export interface BuildKnowledgeMapOptions {
  fingerprint: string;
  generatedAt: string;
}

type Adjacency = Map<string, Map<string, number>>;

function adjacencyOf(graph: ContentGraph, ids: readonly string[]): Adjacency {
  const adjacency: Adjacency = new Map(ids.map((id) => [id, new Map<string, number>()]));
  for (const edge of graph.edges) {
    adjacency.get(edge.a)?.set(edge.b, edge.weight);
    adjacency.get(edge.b)?.set(edge.a, edge.weight);
  }
  return adjacency;
}

const weightInside = (adjacency: Adjacency, id: string, members: ReadonlySet<string>): number => {
  let sum = 0;
  for (const [other, weight] of adjacency.get(id) ?? []) if (members.has(other)) sum += weight;
  return sum;
};

/** The member with the highest weighted degree inside the group, ties by id (plan D4). */
function anchorOf(adjacency: Adjacency, members: readonly string[]): string {
  const set = new Set(members);
  let best = members[0]!;
  let bestWeight = -1;
  for (const id of [...members].sort(byId)) {
    const weight = weightInside(adjacency, id, set);
    if (weight > bestWeight) {
      best = id;
      bestWeight = weight;
    }
  }
  return best;
}

function uniqueId(prefix: string, anchorId: string, taken: Set<string>): string {
  let id = `${prefix}${stableHash(anchorId)}`;
  for (let n = 1; taken.has(id); n++) id = `${prefix}${stableHash(`${anchorId}:${n}`)}`;
  taken.add(id);
  return id;
}

/** Region terms: c-TF-IDF over title and description words, frequency >= 2, top 3. */
function regionTerms(memberSets: string[][], itemsById: Map<string, KnowledgeMapItemInput>): string[][] {
  const words = (item: KnowledgeMapItemInput): Set<string> =>
    new Set(tokenize(`${item.title} ${item.description ?? ""}`).flatMap((token) => token.split(/[-_]+/)).filter(Boolean));
  const counts = memberSets.map((members) => {
    const tf = new Map<string, number>();
    for (const id of members) for (const word of words(itemsById.get(id)!)) tf.set(word, (tf.get(word) ?? 0) + 1);
    return tf;
  });
  const regionsWith = new Map<string, number>();
  for (const tf of counts) for (const word of tf.keys()) regionsWith.set(word, (regionsWith.get(word) ?? 0) + 1);
  return counts.map((tf, r) => {
    const size = memberSets[r]!.length;
    return [...tf.entries()]
      .filter(([, count]) => count >= 2)
      .map(([word, count]) => [word, (count / size) * Math.log(1 + memberSets.length / regionsWith.get(word)!)] as const)
      .sort((x, y) => y[1] - x[1] || byId(x[0], y[0]))
      .slice(0, 3)
      .map(([word]) => word);
  });
}

export function buildKnowledgeMap(input: KnowledgeMapInput, options: BuildKnowledgeMapOptions): KnowledgeMap {
  const items = [...input.items].sort((a, b) => byId(a.id, b.id));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const ids = items.map((item) => item.id);
  const graph = buildContentGraph(input);
  const adjacency = adjacencyOf(graph, ids);

  // Level 1: regions are communities of MIN_REGION or more; smaller ones join the region
  // they tie to most strongly, in a fixed order.
  const { communities } = partition(ids, graph.edges);
  const groups: string[][] = communities.filter((members) => members.length >= MIN_REGION).map((members) => [...members]);
  const regionOf = new Map<string, number>();
  groups.forEach((members, r) => members.forEach((id) => regionOf.set(id, r)));
  const unplaced: string[] = [];
  for (const members of communities.filter((group) => group.length < MIN_REGION)) {
    for (const id of members) {
      const ties = new Map<number, number>();
      for (const [other, weight] of adjacency.get(id)!) {
        const r = regionOf.get(other);
        if (r !== undefined) ties.set(r, (ties.get(r) ?? 0) + weight);
      }
      const best = [...ties.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
      if (best) {
        groups[best[0]]!.push(id);
        regionOf.set(id, best[0]);
      } else unplaced.push(id);
    }
  }

  // Items no content edge reaches get a path home (plan D9): the region holding most items
  // on their node, else on the nearest ancestor. Root items without one are conventions.
  const loose = new Set<string>();
  const conventions: string[] = [];
  for (const id of unplaced) {
    const item = itemsById.get(id)!;
    let home: number | undefined;
    for (let path = primaryPath(item); path !== "/" && home === undefined; path = normalizeNodePath(path.split("/").slice(0, -1).join("/"))) {
      const counts = new Map<number, number>();
      for (const [other, r] of regionOf) {
        if (!loose.has(other) && itemsById.get(other)!.nodePaths.map(normalizeNodePath).includes(path)) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
      home = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0];
    }
    if (home === undefined) conventions.push(id);
    else {
      loose.add(id);
      groups[home]!.push(id);
      regionOf.set(id, home);
    }
  }

  // Region fields and ids.
  const takenIds = new Set<string>();
  const terms = regionTerms(groups, itemsById);
  const regionIds: string[] = [];
  const regions: KnowledgeRegion[] = groups.map((members, r) => {
    const placed = members.filter((id) => !loose.has(id));
    const set = new Set(members);
    const anchorId = anchorOf(adjacency, placed.length > 0 ? placed : members);
    const id = uniqueId("rg_", anchorId, takenIds);
    regionIds[r] = id;
    const ordered = [...members].sort((x, y) => weightInside(adjacency, y, set) - weightInside(adjacency, x, set) || byId(x, y));
    const areas = new Map<string, number>();
    for (const member of members) {
      const area = pathArea(primaryPath(itemsById.get(member)!));
      areas.set(area, (areas.get(area) ?? 0) + 1);
    }
    const [homePath, homeCount] = [...areas.entries()].sort((x, y) => y[1] - x[1] || byId(x[0], y[0]))[0]!;
    let inside = 0;
    let outside = 0;
    for (const member of members) {
      for (const [other, weight] of adjacency.get(member)!) {
        if (regionOf.get(other) === r) inside += weight;
        else outside += weight;
      }
    }
    const subRegions: KnowledgeSubRegion[] = [];
    if (placed.length >= SUBREGION_MIN_ITEMS) {
      const placedSet = new Set(placed);
      const subEdges = graph.edges.filter((edge) => placedSet.has(edge.a) && placedSet.has(edge.b));
      for (const group of partition(placed, subEdges).communities) {
        const subAnchor = anchorOf(adjacency, group);
        const groupSet = new Set(group);
        subRegions.push({
          id: uniqueId("sr_", subAnchor, takenIds),
          anchorId: subAnchor,
          memberIds: [...group].sort((x, y) => weightInside(adjacency, y, groupSet) - weightInside(adjacency, x, groupSet) || byId(x, y)),
        });
      }
    }
    return {
      id,
      anchorId,
      memberIds: ordered,
      terms: terms[r]!,
      homePath,
      pathFit: homeCount / members.length,
      cohesion: inside + outside > 0 ? inside / (inside + outside) : 0,
      tokens: Math.floor(members.reduce((sum, member) => sum + charsOf(itemsById.get(member)!), 0) / 4),
      neighbours: [],
      subRegions,
    };
  });
  regions.forEach((region, r) => {
    const cross = new Map<number, number>();
    for (const member of groups[r]!) {
      for (const [other, weight] of adjacency.get(member)!) {
        const otherRegion = regionOf.get(other);
        if (otherRegion !== undefined && otherRegion !== r) cross.set(otherRegion, (cross.get(otherRegion) ?? 0) + weight);
      }
    }
    region.neighbours = [...cross.entries()]
      .map(([other, weight]) => ({ regionId: regionIds[other]!, weight }))
      .sort((x, y) => y.weight - x.weight || byId(x.regionId, y.regionId))
      .slice(0, 3);
  });

  const subRegionOf = new Map<string, string>();
  for (const region of regions) for (const sub of region.subRegions) for (const member of sub.memberIds) subRegionOf.set(member, sub.id);
  const mapItems: Record<string, MapItem> = {};
  for (const item of items) {
    const r = regionOf.get(item.id);
    const nodePaths = [...new Set(item.nodePaths.map(normalizeNodePath))].sort(byId);
    mapItems[item.id] = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      nodePaths,
      oneLiner: oneLiner(item.body || item.description),
      tokens: Math.floor(charsOf(item) / 4),
      updatedAt: item.updatedAt,
      anchors: resolveItemAnchors(extractPathAnchors(`${item.body}\n${item.description ?? ""}`), nodePaths),
      regionId: r === undefined ? null : regionIds[r]!,
      subRegionId: subRegionOf.get(item.id) ?? null,
      loose: loose.has(item.id),
      sessions: input.usage ? (input.usage[item.id] ?? 0) : null,
    };
  }

  const findings = mapFindings({ input, graph, adjacency, regions, regionOf: new Map([...regionOf].map(([id, r]) => [id, regionIds[r]!])), items: mapItems, loose });
  return {
    algorithm: KNOWLEDGE_MAP_ALGORITHM,
    workspaceId: input.workspaceId,
    fingerprint: options.fingerprint,
    generatedAt: options.generatedAt,
    semantic: graph.vectorPairs.size > 0 ? input.semantic : "lexical",
    items: mapItems,
    edges: graph.edges,
    regions,
    conventions: conventions.sort(byId),
    findings,
    links: graph.links,
  };
}
