// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  KNOWLEDGE_MAP_TOOL_DESCRIPTION,
  knowledgeMapHandler,
  type KnowledgeMapArgs,
} from "@pathrule/core/knowledge-map/tool.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

// Read-only and always on (never in DEFERRED_WRITE_TOOL_NAMES). The name says what it
// is because Claude Code and Codex show tool names before they load schemas.
export const knowledgeMapTool: ToolDef<KnowledgeMapArgs> = {
  name: "pathrule_knowledge_map",
  title: "Knowledge Map",
  description: KNOWLEDGE_MAP_TOOL_DESCRIPTION,
  inputSchema: {
    workspace_id: z.string().uuid().describe("Workspace UUID."),
    view: z.enum(["atlas", "region", "related"]).describe("atlas: all regions; region: one region's page; related: neighbours of the given seeds."),
    region_id: z.string().regex(/^(rg|sr)_[0-9a-f]{8}$/).optional().describe("Region (rg_) or sub-region (sr_) id from the atlas (view=region)."),
    page: z.number().int().min(1).max(50).optional().describe("Region page (view=region)."),
    purpose: z.enum(["audit", "browse"]).optional().describe("audit appends the audit checklist to region pages."),
    item_ids: z.array(z.string().uuid()).max(20).optional().describe("Memory, rule or skill ids to start from (view=related)."),
    titles: z.array(z.string().min(1).max(200)).max(10).optional().describe("Titles or names to start from (view=related)."),
    files: z.array(z.string().min(1).max(480)).max(100).optional().describe("Workspace-relative file paths (view=related)."),
    query: z.string().min(2).max(300).optional().describe("Free-text query to start from (view=related)."),
    limit: z.number().int().min(1).max(12).optional().describe("Max related entries (default 8)."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext(args.workspace_id);
      const result = await knowledgeMapHandler(ctx, args);
      return result.ok ? { ok: true, ...result.data } : formatToolError(result.error);
    } catch (e) {
      return formatThrown(e);
    }
  },
};
