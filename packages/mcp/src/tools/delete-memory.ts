// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { deleteMemoryHandler } from "@pathrule/core/tools/memories.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  memory_id: string;
  hard?: boolean;
  expected_version_id?: string;
}

export const deleteMemoryTool: ToolDef<Args> = {
  name: "pathrule_delete_memory",
  title: "Delete Memory",
  description:
    "Soft-delete a memory by id. The row is hidden from every read path (lists, get_context, CLAUDE.md render) but remains in the database for 30 days. To bring it back, call pathrule_update_memory with `restore: true`. Pass `hard: true` to permanently remove (workspace_admin only). After calling, relay the returned `human_message` to the user — do not paste raw tool JSON.",
  inputSchema: {
    memory_id: z.string().uuid().describe("Memory UUID."),
    hard: z
      .boolean()
      .optional()
      .describe(
        "Permanently delete (cannot be restored). Workspace_admin only. Default false (soft delete).",
      ),
    expected_version_id: z
      .string()
      .uuid()
      .optional()
      .describe("Optimistic concurrency token from a prior read."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      // Read the record BEFORE it goes, purely so the answer can say WHICH one. A delete
      // takes an id and returns an id, so every reader downstream (the agent's own
      // relay, Studio's "learned this session" rows) could only report that a memory
      // disappeared, never which. One extra read on a rare, deliberate operation.
      const memoryBefore = await ctx.backend?.readMemory(args.memory_id).catch(() => null);
      const named = memoryBefore?.title ? ` "${memoryBefore.title}"` : "";
      const result = await deleteMemoryHandler(ctx, {
        memory_id: args.memory_id,
        hard: args.hard,
        expected_version_id: args.expected_version_id,
      });
      if (!result.ok) return formatToolError(result.error);

      const memory = result.data;
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "memory", id: memory.id }),
        cacheInvalidate({ workspaceId: "__by_node__", kind: "memory-list", id: memory.nodeId }),
        cacheInvalidate({ workspaceId: memory.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, memory.workspaceId);

      const human_message = memory.hard
        ? `Memory${named} permanently deleted.`
        : `Memory${named} deleted. Use pathrule_update_memory with restore:true to bring it back.`;
      return {
        ok: true,
        id: memory.id,
        title: memoryBefore?.title,
        hard: memory.hard,
        human_message,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
