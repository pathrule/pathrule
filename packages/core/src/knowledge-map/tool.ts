// SPDX-License-Identifier: Apache-2.0
//
// The shared handler behind pathrule_knowledge_map on the local MCP server and Remote
// MCP. Read-only and always on: an agent reads the map without asking anyone, and nothing is
// spent until it does. A backend without the optional map methods answers "unavailable"; a
// build that misses its budget answers "computing" and keeps going; a failure is an error.

import { mapStoreError, type ToolContext, type ToolResult } from "../tools/types.js";
import { buildKnowledgeMap } from "./build.js";
import { loadKnowledgeMap } from "./cache.js";
import { relatedKnowledge, renderRelated, type RelatedEntry } from "./related.js";
import { regionPages, renderAtlas, renderRegion } from "./render.js";
import { KNOWLEDGE_MAP_ALGORITHM } from "./types.js";

export interface KnowledgeMapArgs {
  workspace_id: string;
  view: "atlas" | "region" | "related";
  region_id?: string;
  page?: number;
  purpose?: "audit" | "browse";
  item_ids?: string[];
  titles?: string[];
  files?: string[];
  query?: string;
  limit?: number;
}

export interface KnowledgeMapToolResult {
  status: "ready" | "computing" | "unavailable";
  view: KnowledgeMapArgs["view"];
  algorithm: string;
  semantic?: "voyage" | "local" | "lexical";
  region_id?: string;
  page?: number;
  pages?: number;
  text?: string;
  related?: RelatedEntry[];
  retry_after_ms?: number;
}

export const KNOWLEDGE_MAP_TOOL_DESCRIPTION =
  "Read-only map of this workspace's memories, rules and skills, grouped into regions by links and meaning. view=atlas: the whole system in under 1k tokens. view=region: one region's items, relations and issues, paged (purpose=audit adds a checklist). view=related: what else to read or update with given item_ids, titles, files or a query. Use before a quality pass, before updating knowledge, or to see how things relate. No confirmation needed.";

const result = (data: KnowledgeMapToolResult): ToolResult<KnowledgeMapToolResult> => ({ ok: true, data });

export interface KnowledgeMapHandlerOptions {
  /**
   * How long to wait for a first build before answering "computing". A long-lived process
   * (the local MCP server, the host) keeps building after the answer; a serverless function
   * may be frozen once it responds, so Remote MCP waits for the build instead.
   */
  budgetMs?: number;
}

/** Remote MCP: finish the build inside the request (input RPC ~1.5 s + build ~1.5 s measured). */
export const SERVERLESS_KNOWLEDGE_MAP_BUDGET_MS = 25_000;

export async function knowledgeMapHandler(
  ctx: ToolContext,
  args: KnowledgeMapArgs,
  options: KnowledgeMapHandlerOptions = {},
): Promise<ToolResult<KnowledgeMapToolResult>> {
  const base = { view: args.view, algorithm: KNOWLEDGE_MAP_ALGORITHM };
  if (args.view === "region" && !args.region_id) {
    return { ok: false, error: { code: "invalid_args", message: "view=region needs region_id (an rg_ or sr_ id from view=atlas)." } };
  }
  if (args.view === "related" && !(args.item_ids?.length || args.titles?.length || args.files?.length || args.query?.trim())) {
    return { ok: false, error: { code: "invalid_args", message: "view=related needs at least one of item_ids, titles, files or query." } };
  }
  const backend = ctx.backend;
  if (!backend) return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  if (!backend.buildKnowledgeMapInput || !backend.knowledgeMapFingerprint) {
    return result({ ...base, status: "unavailable", text: "This backend does not provide a knowledge map." });
  }

  let fingerprint: string | null;
  try {
    fingerprint = await backend.knowledgeMapFingerprint(args.workspace_id);
  } catch (error) {
    return { ok: false, error: mapStoreError(error as { code?: string; message: string }) };
  }
  if (!fingerprint) return result({ ...base, status: "unavailable", text: "This workspace has no knowledge map yet." });

  const buildInput = backend.buildKnowledgeMapInput.bind(backend);
  const load = await loadKnowledgeMap({
    workspaceId: args.workspace_id,
    fingerprint,
    budgetMs: options.budgetMs,
    build: async () => {
      const input = await buildInput(args.workspace_id);
      if (!input) throw new Error("The backend returned no knowledge map input.");
      return buildKnowledgeMap(input, { fingerprint: fingerprint!, generatedAt: new Date().toISOString() });
    },
  });
  if (load.status === "computing") {
    return result({ ...base, status: "computing", retry_after_ms: load.retryAfterMs, text: "The knowledge map is being built; call again shortly." });
  }
  if (load.status === "error") {
    return { ok: false, error: mapStoreError(load.error as { code?: string; message: string }) };
  }

  const map = load.map;
  const ready = { ...base, status: "ready" as const, semantic: map.semantic };
  if (args.view === "atlas") {
    // Advisory: a failed findings read costs the atlas its gaps line, never the atlas.
    const gaps = backend.knowledgeGapSummary ? await backend.knowledgeGapSummary(args.workspace_id).catch(() => null) : null;
    return result({ ...ready, text: renderAtlas(map, { gaps }) });
  }

  if (args.view === "region") {
    const id = args.region_id!;
    const region = map.regions.find((r) => r.id === id || r.subRegions.some((sub) => sub.id === id));
    if (!region) {
      return {
        ok: false,
        error: { code: "not_found", message: `No region ${id} in the current map; region ids change only when the knowledge does, so read view=atlas again.` },
      };
    }
    const pages = regionPages(map, region);
    const page = id.startsWith("sr_") && !args.page ? Math.max(1, pages.findIndex((p) => p.subRegionId === id) + 1) : (args.page ?? 1);
    return result({ ...ready, region_id: region.id, page, pages: pages.length, text: renderRegion(map, region, { page, purpose: args.purpose }) });
  }

  const related = relatedKnowledge(map, {
    itemIds: args.item_ids,
    titles: args.titles,
    files: args.files,
    query: args.query,
    limit: args.limit,
  });
  return result({ ...ready, related, text: renderRelated(related) });
}
