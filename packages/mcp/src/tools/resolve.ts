// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { resolveHandler } from "@pathrule/core/tools/resolve.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  query: string;
  kind?: "memory" | "rule" | "skill";
  node_path?: string;
  workspace_id?: string;
  cwd?: string;
  limit?: number;
  include_body?: boolean;
}

export const resolveTool: ToolDef<Args> = {
  name: "pathrule_resolve",
  title: "Resolve Name to Edit Handle",
  description:
    "Cheaply map a memory TITLE or rule/skill NAME (the label you already see in the compiled knowledge / injected context) to its editing handle: `{ id, node_path, version_id }`. Use this BEFORE update_*/read_*/delete_* when you know WHAT to edit but not its id — do NOT pull the tree or read candidate bodies to hunt for the id. Reads only titles+ids to match. For a single unambiguous match it also returns `version_id` AND the full `content` (unless include_body:false), so a resolve+read collapses into ONE call — read it, then update_* with a `content_edit` delta. Pass `node_path` to disambiguate same-named items. Returns `{ matches: [...], unique }`.",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe("The memory title or rule/skill name to resolve (exact, prefix, or substring)."),
    kind: z
      .enum(["memory", "rule", "skill"])
      .optional()
      .describe("Restrict to one kind. Omit to search memories, rules, and skills."),
    node_path: z
      .string()
      .optional()
      .describe(
        "Restrict to items attached at this workspace-relative path (e.g. '/packages/app'). Use to disambiguate a name that exists at multiple paths.",
      ),
    workspace_id: z
      .string()
      .uuid()
      .optional()
      .describe("Workspace UUID. Provide it if you already have it (from get_context); otherwise it resolves from cwd."),
    cwd: z
      .string()
      .optional()
      .describe("Absolute working directory used to resolve the workspace when workspace_id is omitted."),
    limit: z.number().int().min(1).max(50).optional().describe("Max matches to return (default 8)."),
    include_body: z
      .boolean()
      .optional()
      .describe(
        "For a single unambiguous match, also return its full `content` (default true — the row is read for version_id anyway, so the body is free). Set false to keep the response to just the handle.",
      ),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      if (!ctx.backend) {
        return formatToolError({ code: "upstream_error", message: "No backend configured." });
      }
      let workspaceId = args.workspace_id ?? null;
      if (!workspaceId) {
        const cwd = args.cwd ?? process.cwd();
        const match = await ctx.backend.resolveWorkspaceFromCwd(cwd);
        if (!match) {
          return formatToolError({
            code: "not_found",
            message: `No Pathrule workspace covers ${cwd}. Pass workspace_id, or run from a bound folder.`,
          });
        }
        workspaceId = match.workspaceId;
      }
      const result = await resolveHandler(ctx, {
        workspaceId,
        query: args.query,
        kind: args.kind,
        node_path: args.node_path,
        limit: args.limit,
        include_body: args.include_body,
      });
      if (!result.ok) return formatToolError(result.error);
      return { ok: true, ...result.data };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
