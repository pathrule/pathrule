// SPDX-License-Identifier: Apache-2.0
import type {
  RoutingResult,
  ContextDepth,
  ResponseSection,
} from "@pathrule/protocol/routing-types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InlineSource = "router" | "fallback" | "none";

export interface InlineDecision {
  ids: string[];
  source: InlineSource;
}

function extractRouterIds(include: ResponseSection[] | undefined): string[] {
  if (!Array.isArray(include)) return [];
  const out = new Set<string>();
  for (const entry of include) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith("preload_memory:")) continue;
    const id = entry.slice("preload_memory:".length);
    if (UUID_RE.test(id)) out.add(id);
  }
  return Array.from(out);
}

/**
 * Decide which memory body (if any) to inline in preloaded_memories.
 *
 * Priority:
 *   1. Router emitted `preload_memory:<uuid>` in include[] → use it (router source).
 *   2. Router's decision satisfies `next=read_memory + confidence=high + memory_id`
 *      (equivalent "clear winner" signal) → fallback source.
 *   3. Otherwise no inline.
 *
 * Deep mode always skips — deep briefing is already broad-scope context.
 * Max 1 inline id returned total (across both mechanisms).
 */
export function resolveInlineIds(
  routing: RoutingResult,
  depth: ContextDepth,
): InlineDecision {
  if (depth === "deep") return { ids: [], source: "none" };

  const decision = routing.decision;
  const routerIds = extractRouterIds(decision?.include);
  if (routerIds.length > 0) {
    return { ids: routerIds.slice(0, 1), source: "router" };
  }

  if (
    decision?.next === "read_memory" &&
    decision.confidence === "high" &&
    decision.memory_id &&
    UUID_RE.test(decision.memory_id)
  ) {
    return { ids: [decision.memory_id], source: "fallback" };
  }

  return { ids: [], source: "none" };
}
