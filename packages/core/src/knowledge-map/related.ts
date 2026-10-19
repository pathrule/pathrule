// SPDX-License-Identifier: Apache-2.0
//
// "what else should I read or update with this?" Seeds plus their one-hop typed
// neighbours, each with a reason, never a whole region (plan D6): expanding a sub-region
// mixed unrelated knowledge in the prototype (correction 3).

import { ancestorDirectories, normalizeAnchorPath, pathDepth } from "./anchors.js";
import { NEAR_DUPLICATE } from "./graph.js";
import { buildLexicalIndex, queryScores, type LexicalIndex } from "./lexical.js";
import { createLinkResolver } from "./links.js";
import { RELATED_MAX_CHARS, capLines } from "./render.js";
import type { KnowledgeMap, MapEdge, MapItem } from "./types.js";

export const RELATED_DEFAULT_LIMIT = 8;
export const RELATED_MAX_LIMIT = 12;
/** A reference to the directory above a file anchors it only from this depth ("packages/app" is too broad). */
export const PARENT_REF_MIN_DEPTH = 3;
const QUERY_SEEDS = 3;
// The query on the file-evidence scale (3 = references the file itself): it is the caller saying
// what the files are about, so a full match weighs like a direct reference.
const QUERY_WEIGHT = 3;
/** A node above the file's parent, scaled by how far down the file's directory it reaches. */
const CHAIN_STRENGTH = 0.5;
const MIN_SEMANTIC_WEIGHT = 0.3;
const HOP_ROOM = 2;

export interface RelatedQuery {
  itemIds?: string[];
  titles?: string[];
  files?: string[];
  query?: string;
  limit?: number;
}

export interface RelatedEntry {
  id: string;
  kind: "memory" | "rule" | "skill";
  title: string;
  nodePath: string;
  /** Why it is here: "direct match", "references <file>", "links to <title>", ... */
  reason: string;
  score: number;
  seed: boolean;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface FileAnchor {
  reason: string;
  /** 3 the file itself, 2 its directory, 1 the directory above, under 0.5 a node further up. */
  strength: number;
}

/**
 * How specifically an item's knowledge is about this file. A path reference anchors the file
 * itself, its directory, or the directory above from depth 3 ("packages/app/src" says too little
 * about a file four levels down), scaled by `referenceWeight`. The item's node anchors its own
 * directory as strongly as a reference to it, the directory above less, and any node further up
 * (never the root) weakly and less the higher it sits: that is the path chain delivery already
 * follows, deepest first, ranked below anything more specific. The strongest evidence wins.
 */
export function fileAnchor(item: MapItem, file: string, referenceWeight = 1): FileAnchor | null {
  const path = normalizeAnchorPath(file);
  const [dir, parent, ...above] = ancestorDirectories(path);
  const nodes = item.nodePaths.map(normalizeAnchorPath).filter(Boolean);
  let best: FileAnchor | null = null;
  const consider = (reason: string, strength: number): void => {
    if (!best || strength > best.strength) best = { reason, strength };
  };
  if (item.anchors.includes(path)) consider(`references ${path}`, 3 * referenceWeight);
  else if (dir && item.anchors.includes(dir)) consider(`references ${dir}`, 2 * referenceWeight);
  else if (parent && pathDepth(parent) >= PARENT_REF_MIN_DEPTH && item.anchors.includes(parent)) consider(`references ${parent}`, referenceWeight);
  if (dir && nodes.includes(dir)) consider(`lives at /${dir}`, 2);
  else if (parent && nodes.includes(parent)) consider(`lives at /${parent}`, 1);
  else {
    const up = above.find((directory) => nodes.includes(directory));
    if (up) consider(`lives at /${up}, above the file`, (CHAIN_STRENGTH * pathDepth(up)) / pathDepth(dir!));
  }
  return best;
}

/**
 * How much one of an item's path references says about a place: 1 / sqrt(areas), where areas
 * are the distinct workspace areas (first two segments under a top-level directory the
 * workspace has nodes in) its references reach. An architecture map that names twenty areas says
 * little about any one of them, as a long document is close to everything (the CSLS idea).
 */
export function referenceWeight(item: MapItem, roots: ReadonlySet<string>): number {
  const areas = new Set<string>();
  for (const anchor of item.anchors) {
    const [first, second] = anchor.split("/");
    if (first && second && roots.has(first)) areas.add(`${first}/${second}`);
  }
  return 1 / Math.sqrt(Math.max(1, areas.size));
}

/** The words a file name carries: "DesignMotionDock.tsx" -> "DesignMotionDock Design Motion Dock". */
export function fileNameText(file: string): string {
  const base = normalizeAnchorPath(file).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const parts = stem
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[\s._-]+/u);
  return [stem, ...parts].filter(Boolean).join(" ");
}

/** Lexical scores scaled so the best match is 1, best first. */
function scaledScores(index: LexicalIndex, text: string): Map<string, number> {
  const scores = queryScores(index, text);
  const best = scores[0]?.[1] ?? 0;
  return new Map(best > 0 ? scores.map(([id, score]) => [id, score / best]) : []);
}

function relation(edge: MapEdge, kindA: string, kindB: string): { label: "link" | "companion" | "duplicate" | "related"; weight: number } {
  const weight = edge.weight * (edge.kinds.includes("link") ? 1.2 : 1);
  if (edge.kinds.includes("link")) return { label: "link", weight };
  if ((edge.similarity ?? 0) >= NEAR_DUPLICATE) return { label: kindA === kindB ? "duplicate" : "companion", weight };
  return { label: "related", weight };
}

export function relatedKnowledge(map: KnowledgeMap, query: RelatedQuery): RelatedEntry[] {
  const limit = Math.min(Math.max(1, query.limit ?? RELATED_DEFAULT_LIMIT), RELATED_MAX_LIMIT);
  const items = map.items;
  const seeds = new Map<string, string>();
  const addSeed = (id: string, reason: string): void => {
    if (items[id] && !seeds.has(id)) seeds.set(id, reason);
  };
  for (const id of query.itemIds ?? []) addSeed(id, "direct match");
  if (query.titles?.length) {
    const resolver = createLinkResolver(Object.values(items).map((item) => ({ id: item.id, kind: item.kind, title: item.title })));
    for (const title of query.titles) {
      const hit = resolver.resolve(title.trim().startsWith("::") ? title.trim() : title);
      if (hit) addSeed(hit.id, "direct match");
    }
  }
  const files = [...new Set((query.files ?? []).map(normalizeAnchorPath))].filter(Boolean);
  const text = query.query?.trim() ?? "";
  if (files.length > 0 || text) {
    // Everything the files or the query point at, by evidence: how specifically it anchors the
    // files (mean fileAnchor strength) plus how well it matches the query and the files' names.
    const index = buildLexicalIndex(Object.values(items).map((item) => ({ id: item.id, title: item.title, text: item.oneLiner })));
    const byQuery = text ? scaledScores(index, text) : new Map<string, number>();
    const byName = files.length > 0 ? scaledScores(index, files.map(fileNameText).join(" ")) : new Map<string, number>();
    const queryPicks = new Set([...byQuery.keys()].slice(0, QUERY_SEEDS));
    const roots = new Set(Object.values(items).flatMap((item) => item.nodePaths.map((node) => normalizeAnchorPath(node).split("/")[0]!).filter(Boolean)));
    const ranked: Array<{ id: string; score: number; name: number; reason: string }> = [];
    for (const id of Object.keys(items).sort(byId)) {
      const weight = files.length > 0 ? referenceWeight(items[id]!, roots) : 1;
      let strength = 0;
      let covered = 0;
      let first: FileAnchor | null = null;
      for (const file of files) {
        const anchor = fileAnchor(items[id]!, file, weight);
        if (!anchor) continue;
        strength += anchor.strength;
        covered++;
        if (!first || anchor.strength > first.strength) first = anchor;
      }
      if (!first && !queryPicks.has(id)) continue;
      const score = (files.length > 0 ? strength / files.length : 0) + QUERY_WEIGHT * (byQuery.get(id) ?? 0);
      const reason = !first ? "matches the query" : covered > 1 ? `${first.reason} and ${covered - 1} more of the given files` : first.reason;
      ranked.push({ id, score, name: first ? (byName.get(id) ?? 0) : 0, reason });
    }
    // The files' names break ties between items with the same evidence; a word in a file name
    // ("index", "types") is never on its own a reason to rank something higher.
    ranked.sort((x, y) => y.score - x.score || y.name - x.name || byId(x.id, y.id));
    for (const r of ranked) addSeed(r.id, r.reason);
  }

  // Neighbours come only from the seeds that will be shown, so every reason names an entry
  // the agent can see. Seeds beyond that room fill in only when there are few neighbours.
  const allSeeds = [...seeds.entries()];
  const shown = new Set(allSeeds.slice(0, Math.max(1, limit - HOP_ROOM)).map(([id]) => id));
  const candidates = new Map<string, { score: number; best: { label: string; weight: number; via: string; similarity?: number } }>();
  for (const edge of map.edges) {
    for (const [seed, other] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
      if (!shown.has(seed) || seeds.has(other)) continue;
      const rel = relation(edge, items[seed]!.kind, items[other]!.kind);
      const bonus = rel.label === "companion" ? 0.5 : rel.label === "duplicate" ? 0.3 : 0;
      const entry = candidates.get(other) ?? { score: 0, best: { label: rel.label, weight: -1, via: seed } };
      entry.score += rel.weight + bonus;
      if (rel.weight > entry.best.weight || (rel.weight === entry.best.weight && byId(seed, entry.best.via) < 0)) {
        entry.best = { label: rel.label, weight: rel.weight, via: seed, similarity: edge.similarity };
      }
      candidates.set(other, entry);
    }
  }

  const title = (id: string): string => items[id]!.title;
  const entry = (id: string, reason: string, score: number, seed: boolean): RelatedEntry => ({
    id,
    kind: items[id]!.kind,
    title: items[id]!.title,
    nodePath: items[id]!.nodePaths[0] ?? "/",
    reason,
    score: Math.round(score * 1000) / 1000,
    seed,
  });
  const ranked = [...candidates.entries()]
    // A neighbour reached only through a weak semantic edge is noise, not a relation.
    .filter(([, c]) => !(c.best.label === "related" && c.best.weight < MIN_SEMANTIC_WEIGHT))
    .sort((x, y) => y[1].score - x[1].score || byId(x[0], y[0]));
  // Seeds come first but leave room for the neighbours that make this more than a search.
  const seedRoom = Math.max(shown.size, limit - Math.min(HOP_ROOM, ranked.length));
  const out: RelatedEntry[] = allSeeds.slice(0, seedRoom).map(([id, reason]) => entry(id, reason, 0, true));
  for (const [id, c] of ranked) {
    const similarity = c.best.similarity !== undefined ? ` (${Math.round(c.best.similarity * 100) / 100})` : "";
    const reason =
      c.best.label === "link"
        ? `links with ${title(c.best.via)}`
        : c.best.label === "companion"
          ? `companion of ${title(c.best.via)}; update them together`
          : c.best.label === "duplicate"
            ? `says nearly the same as ${title(c.best.via)}${similarity}`
            : `related to ${title(c.best.via)}${similarity}`;
    out.push(entry(id, reason, c.score, false));
  }
  return out.slice(0, limit);
}

const KIND_LETTER = { memory: "M", rule: "R", skill: "S" } as const;

export function renderRelated(entries: readonly RelatedEntry[]): string {
  if (entries.length === 0) return "No related knowledge found for these seeds.";
  const lines = [
    `Related knowledge (${entries.length}): seeds first, then one-hop neighbours. Read with pathrule_read by id; companions usually need the same change.`,
    ...entries.map((e) => `- [${KIND_LETTER[e.kind]}] ${e.title} (${e.nodePath}) ${e.id}: ${e.reason}`),
  ];
  return capLines(lines, RELATED_MAX_CHARS, (left) => `(+${left} more; pass fewer seeds or a smaller limit)`);
}
