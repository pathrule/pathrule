// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { listMemoriesHandler } from "@pathrule/core/tools/memories.js";
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

export const listMemoriesTool: ToolDef<{ node_id: string }> = {
  name: "pathrule_list_memories",
  title: "List Memories",
  description:
    "Return the MainMemory.md-style index (title + preview) for every memory under a node. Use to decide which memory to read in full.",
  inputSchema: {
    node_id: z.string().uuid().describe("Tree node UUID."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      const key = { workspaceId: "__by_node__", kind: "memory-list" as const, id: args.node_id };
      const cached = await cacheGet<unknown[]>(key);
      if (cached) return { ok: true, memories: cached, cache_hit: true };

      const result = await listMemoriesHandler(ctx, { node_id: args.node_id });
      if (!result.ok) return formatToolError(result.error);
      const compact = result.data.map((m) => ({
        id: m.id,
        title: m.title,
        preview: (m.content ?? "").slice(0, 160),
        node_id: m.nodeId,
        updated_at: m.updatedAt,
      }));
      await cachePut(key, compact);
      return { ok: true, memories: compact };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
