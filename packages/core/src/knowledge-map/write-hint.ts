// SPDX-License-Identifier: Apache-2.0
//
// After an agent updates a memory, rule or skill, name up to three items that may
// need the same change, from a map that is already cached. Never builds a map and never adds
// a byte when there is nothing strong to say.

import { NEAR_DUPLICATE } from "./graph.js";
import type { KnowledgeMap, MapEdge } from "./types.js";

export const RELATED_TO_CHECK_MAX = 3;
export const RELATED_TO_CHECK_MAX_CHARS = 600;

export interface RelatedToCheck {
  id: string;
  kind: "memory" | "rule" | "skill";
  title: string;
  reason: string;
}

const RANK = { companion: 0, link: 1, duplicate: 2 } as const;

function strongRelation(edge: MapEdge, sameKind: boolean): keyof typeof RANK | null {
  if ((edge.similarity ?? 0) >= NEAR_DUPLICATE) return sameKind ? "duplicate" : "companion";
  if (edge.kinds.includes("link")) return "link";
  return null;
}

/** Up to 3 strong neighbours of `itemId` (companion, link, near duplicate), under 600 chars. */
export function relatedToCheck(map: KnowledgeMap | null, itemId: string): RelatedToCheck[] {
  const self = map?.items[itemId];
  if (!map || !self) return [];
  const candidates: Array<{ id: string; relation: keyof typeof RANK; edge: MapEdge }> = [];
  for (const edge of map.edges) {
    const other = edge.a === itemId ? edge.b : edge.b === itemId ? edge.a : null;
    if (!other || !map.items[other]) continue;
    const relation = strongRelation(edge, map.items[other]!.kind === self.kind);
    if (relation) candidates.push({ id: other, relation, edge });
  }
  candidates.sort(
    (x, y) => RANK[x.relation] - RANK[y.relation] || y.edge.weight - x.edge.weight || (x.id < y.id ? -1 : 1),
  );
  const out: RelatedToCheck[] = [];
  let size = 0;
  for (const { id, relation, edge } of candidates.slice(0, RELATED_TO_CHECK_MAX)) {
    const item = map.items[id]!;
    const title = item.title.length <= 80 ? item.title : `${item.title.slice(0, 79).trimEnd()}…`;
    const reason =
      relation === "companion"
        ? `says the same as this ${self.kind}; it may need the same change`
        : relation === "duplicate"
          ? `near duplicate (${Math.round((edge.similarity ?? 0) * 100) / 100}); consider merging`
          : "links with this item";
    const entry = { id, kind: item.kind, title, reason };
    size += JSON.stringify(entry).length;
    if (size > RELATED_TO_CHECK_MAX_CHARS) break;
    out.push(entry);
  }
  return out;
}

/** Remembers which items already got a hint, so one session hears it once per item. */
export function createWriteHintLedger(): (workspaceId: string, itemId: string, map: KnowledgeMap | null) => RelatedToCheck[] {
  const delivered = new Set<string>();
  return (workspaceId, itemId, map) => {
    const key = `${workspaceId}:${itemId}`;
    if (delivered.has(key)) return [];
    const hint = relatedToCheck(map, itemId);
    if (hint.length > 0) delivered.add(key);
    return hint;
  };
}
