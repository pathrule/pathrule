// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { getNodeHandler } from "@pathrule/core/tools/tree.js";
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

export const getNodeTool: ToolDef<{ node_id: string }> = {
  name: "pathrule_get_node",
  title: "Get Node Detail",
  description:
    "Return a single node plus the ids of every memory, rule, and skill attached to it. Follow up with read_memory / read_rule / read_skill as needed.",
  inputSchema: {
    node_id: z.string().uuid().describe("Tree node UUID."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      // Cache keyed on the node id; workspace scoped via the shared cache root.
      // We don't know the workspace_id yet, so we use a "__unknown__" bucket
      // that still correctly TTLs per call.
      const key = { workspaceId: "__unknown__", kind: "node" as const, id: args.node_id };
      const cached = await cacheGet<unknown>(key);
      if (cached) return { ok: true, ...(cached as object), cache_hit: true };

      const result = await getNodeHandler(ctx, { node_id: args.node_id });
      if (!result.ok) return formatToolError(result.error);
      await cachePut(key, result.data);
      return { ok: true, ...result.data };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
