// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { listPendingRefreshesHandler } from "@pathrule/core/tools/refreshes.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id: string;
  include_in_progress?: boolean;
}

export const listPendingRefreshesTool: ToolDef<Args> = {
  name: "pathrule_list_pending_refreshes",
  title: "List pending memory/rule refresh tasks",
  description:
    "List the open refresh tasks in this workspace: memories or rules an agent flagged with `pathrule_request_refresh`. Each task points to a memory/rule that looks stale, with a plain-language reason and optional AI instructions. Call `pathrule_get_refresh_brief` for full context, then use your own file-access tools to investigate, call `pathrule_update_memory`/`pathrule_update_rule` with `refresh_id` to apply a fix, and finally `pathrule_resolve_refresh` to close the loop.",
  inputSchema: {
    workspace_id: z
      .string()
      .uuid()
      .describe("Workspace UUID. Use the `workspace_id` surfaced by `pathrule_get_context` or the session digest."),
    include_in_progress: z
      .boolean()
      .optional()
      .describe("Include tasks previously claimed (status='in_progress'). Default false — returns only freshly pending tasks."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext(args.workspace_id);
      const result = await listPendingRefreshesHandler(ctx, {
        workspace_id: args.workspace_id,
        include_in_progress: args.include_in_progress,
      });
      if (!result.ok) return formatToolError(result.error);
      return {
        ok: true,
        refreshes: result.data,
        total: result.data.length,
        human_message:
          result.data.length === 0
            ? "No pending refresh tasks."
            : `${result.data.length} refresh task(s) waiting. Use pathrule_get_refresh_brief on one to start.`,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
