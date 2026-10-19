// SPDX-License-Identifier: Apache-2.0
//
// The boundary check for a knowledge map input that arrives as an RPC payload. The
// types live in @pathrule/core (KnowledgeBackend.buildKnowledgeMapInput returns them); the
// parser lives here so core keeps no runtime code for the map.

import type {
  KnowledgeMapInput,
  KnowledgeMapItemInput,
  KnowledgeMapItemKind,
  KnowledgeMapSemanticSource,
} from "../backend/knowledge-map-input.js";

export type { KnowledgeMapInput, KnowledgeMapItemInput, KnowledgeMapItemKind, KnowledgeMapSemanticSource };

const KINDS = new Set<string>(["memory", "rule", "skill"]);

/** Shape check at the backend boundary; throws on anything the map cannot trust. */
export function parseKnowledgeMapInput(workspaceId: string, raw: unknown): KnowledgeMapInput {
  const value = raw as {
    items?: unknown[];
    neighbours?: unknown[];
    semantic?: unknown;
    usage?: unknown;
    usage_window_days?: unknown;
  } | null;
  if (!value || !Array.isArray(value.items)) throw new Error("knowledge_map_input: items missing");
  const items: KnowledgeMapItemInput[] = value.items.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !KINDS.has(String(r.kind)) || typeof r.title !== "string") {
      throw new Error("knowledge_map_input: bad item");
    }
    return {
      id: r.id,
      kind: r.kind as KnowledgeMapItemKind,
      title: r.title,
      description: typeof r.description === "string" ? r.description : null,
      body: typeof r.body === "string" ? r.body : "",
      nodePaths: Array.isArray(r.node_paths) ? r.node_paths.filter((p): p is string => typeof p === "string") : [],
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
    };
  });
  const neighbours = (Array.isArray(value.neighbours) ? value.neighbours : []).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const [a, b, s] = row as unknown[];
    return typeof a === "string" && typeof b === "string" && typeof s === "number" && Number.isFinite(s)
      ? [[a, b, s] as [string, string, number]]
      : [];
  });
  const semantic: KnowledgeMapSemanticSource =
    value.semantic === "voyage" || value.semantic === "local" ? value.semantic : "lexical";
  const usage =
    value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
      ? (Object.fromEntries(
          Object.entries(value.usage as Record<string, unknown>).filter(
            ([, n]) => typeof n === "number" && Number.isFinite(n),
          ),
        ) as Record<string, number>)
      : null;
  const usageWindowDays = typeof value.usage_window_days === "number" ? value.usage_window_days : null;
  return { workspaceId, items, neighbours, semantic: neighbours.length > 0 ? semantic : "lexical", usage, usageWindowDays };
}
