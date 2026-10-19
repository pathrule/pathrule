// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { resolveRefreshHandler } from "@pathrule/core/tools/refreshes.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  refresh_id: string;
  status: "applied" | "rejected";
  note?: string;
  claimed_by?: string;
}

export const resolveRefreshTool: ToolDef<Args> = {
  name: "pathrule_resolve_refresh",
  title: "Close a memory/rule refresh task",
  description:
    "Mark a refresh task as applied (you successfully updated the memory/rule) or rejected (the suggestion was wrong or no longer relevant). If you already passed `refresh_id` to `pathrule_update_memory`/`_update_rule`, the task is auto-resolved and you can skip this call.",
  inputSchema: {
    refresh_id: z.string().uuid().describe("Refresh task UUID."),
    status: z
      .enum(["applied", "rejected"])
      .describe(
        "'applied' when you updated the memory/rule; 'rejected' when you decided the suggestion is wrong or obsolete.",
      ),
    note: z
      .string()
      .max(500)
      .optional()
      .describe("Optional — short note to the user about what you changed or why you rejected."),
    claimed_by: z
      .string()
      .max(40)
      .optional()
      .describe("Optional — overwrite the claimant identifier (e.g. 'claude-code')."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();
      const result = await resolveRefreshHandler(ctx, {
        refresh_id: args.refresh_id,
        status: args.status,
        note: args.note,
        claimed_by: args.claimed_by,
      });
      if (!result.ok) return formatToolError(result.error);
      return {
        ok: true,
        refresh_id: result.data.id,
        status: result.data.status,
        resolved_at: result.data.resolvedAt,
        human_message: `Refresh task marked ${args.status}.`,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
