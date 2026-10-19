// SPDX-License-Identifier: Apache-2.0
//
// Test fixture, built in code: no real workspace content. Clusters of items that link
// each other and share vocabulary, with synthetic vector neighbours inside each cluster.

import type { KnowledgeMapInput, KnowledgeMapItemInput } from "../../index.js";

export function item(
  id: string,
  title: string,
  body: string,
  path = "/",
  kind: KnowledgeMapItemInput["kind"] = "memory",
): KnowledgeMapItemInput {
  return { id, kind, title, description: null, body, nodePaths: [path], updatedAt: "2026-09-01T00:00:00.000Z" };
}

export interface ClusterSpec {
  prefix: string;
  size: number;
  path: string;
  /** Distinctive words every member's body repeats. */
  words: string[];
  /** Vector similarity between members (memories only). */
  similarity?: number;
}

/** Members chain-link each other ([[prefix note i+1]]) and share the cluster's words. */
export function cluster(spec: ClusterSpec): { items: KnowledgeMapItemInput[]; neighbours: Array<[string, string, number]> } {
  const items: KnowledgeMapItemInput[] = [];
  for (let i = 0; i < spec.size; i++) {
    const next = (i + 1) % spec.size;
    items.push(
      item(
        `${spec.prefix}-${String(i).padStart(3, "0")}`,
        `${spec.prefix} note ${i}`,
        `${spec.words.join(" ")} detail${spec.prefix}${i} see [[${spec.prefix} note ${next}]]`,
        spec.path,
      ),
    );
  }
  const neighbours: Array<[string, string, number]> = [];
  const similarity = spec.similarity ?? 0.75;
  for (const a of items) for (const b of items) if (a.id !== b.id) neighbours.push([a.id, b.id, similarity]);
  return { items, neighbours };
}

export function workspace(
  parts: Array<{ items: KnowledgeMapItemInput[]; neighbours?: Array<[string, string, number]> }>,
  extra: Partial<KnowledgeMapInput> = {},
): KnowledgeMapInput {
  const items = parts.flatMap((part) => part.items);
  const neighbours = parts.flatMap((part) => part.neighbours ?? []);
  return {
    workspaceId: "ws-fixture",
    items,
    neighbours,
    semantic: neighbours.length > 0 ? "voyage" : "lexical",
    usage: null,
    usageWindowDays: null,
    ...extra,
  };
}

const VOCABULARY = Array.from({ length: 400 }, (_, i) => `term${i.toString(36)}`);

/** A large fixture for size caps: `regions` clusters of `perRegion` items. */
export function largeWorkspace(regions: number, perRegion: number): KnowledgeMapInput {
  const parts = Array.from({ length: regions }, (_, r) =>
    cluster({
      prefix: `c${r}`,
      size: perRegion,
      path: `/packages/p${r % 7}/src/area${r}`,
      words: VOCABULARY.slice((r * 5) % VOCABULARY.length, ((r * 5) % VOCABULARY.length) + 5),
    }),
  );
  return workspace(parts);
}
