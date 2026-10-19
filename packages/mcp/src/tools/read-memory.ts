// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readMemoryHandler } from "@pathrule/core/tools/memories.js";
// Deep import: the ledger does node:fs IO, so it is deliberately not in the shared
// barrel — that barrel is also loaded by browser bundles.
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { recordExplicitRead } from "../lib/delivery.js";
import { formatThrown, formatToolError } from "../errors.js";
import { compactMemory, type CompactMemory } from "../lib/read-compact.js";
import type { ToolDef } from "./types.js";

export const readMemoryTool: ToolDef<{ memory_id?: string; id?: string }> = {
  name: "pathrule_read_memory",
  title: "Read Memory",
  description:
    "Return a single memory. Response is flat (fields at top level, no wrapper): id, title, content, node_path, source, version_id, updated_at. version_id is the optimistic concurrency token — pass it as expected_version_id when calling pathrule_update_memory. Legacy response.memory.* wrapper removed in M14.",
  inputSchema: {
    memory_id: z.string().uuid().optional().describe("Memory UUID."),
    // Agents read "(id: …)" in the hook's lines and pass `id`; refusing it cost a retry step (measured 2026-10-15).
    id: z.string().uuid().optional().describe("Same as memory_id."),
  },
  handler: async (args) => {
    const memoryId = args.memory_id ?? args.id;
    if (!memoryId) return formatToolError({ code: "invalid_args", message: "Pass memory_id (the memory's UUID)." });
    try {
      const ctx = await resolveContext();
      const key = { workspaceId: "__by_id__", kind: "memory" as const, id: memoryId };
      const cached = await cacheGet<CompactMemory>(key);
      if (cached) {
        void recordExplicitRead(ctx.workspaceId, "memory", cached, "pathrule_read_memory");
        return { ok: true, ...cached, cache_hit: true };
      }

      const result = await readMemoryHandler(ctx, { memory_id: memoryId });
      if (!result.ok) return formatToolError(result.error);
      const compact = compactMemory(result.data);
      await cachePut(key, compact);
      void recordExplicitRead(ctx.workspaceId, "memory", compact, "pathrule_read_memory");
      return { ok: true, ...compact };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
