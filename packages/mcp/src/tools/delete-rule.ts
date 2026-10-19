// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { deleteRuleHandler } from "@pathrule/core/tools/rules.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  rule_id: string;
  hard?: boolean;
  expected_version_id?: string;
}

export const deleteRuleTool: ToolDef<Args> = {
  name: "pathrule_delete_rule",
  title: "Delete Rule",
  description:
    "Soft-delete a rule by id. The rule stops applying immediately and is hidden from every read path (lists, get_context, CLAUDE.md render) but remains in the database for 30 days. To bring it back, call pathrule_update_rule with `restore: true`. Pass `hard: true` to permanently remove (workspace_admin only). After calling, relay the returned `human_message` to the user — do not paste raw tool JSON.",
  inputSchema: {
    rule_id: z.string().uuid().describe("Rule UUID."),
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
      // relay, Studio's "learned this session" rows) could only report that a rule
      // disappeared, never which. One extra read on a rare, deliberate operation.
      const ruleBefore = await ctx.backend?.readRule(args.rule_id).catch(() => null);
      const named = ruleBefore?.name ? ` "${ruleBefore.name}"` : "";
      const result = await deleteRuleHandler(ctx, {
        rule_id: args.rule_id,
        hard: args.hard,
        expected_version_id: args.expected_version_id,
      });
      if (!result.ok) return formatToolError(result.error);

      const rule = result.data;
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "rule", id: rule.id }),
        cacheInvalidate({ workspaceId: rule.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, rule.workspaceId);

      const human_message = rule.hard
        ? `Rule${named} permanently deleted.`
        : `Rule${named} deleted. Use pathrule_update_rule with restore:true to bring it back.`;
      return {
        ok: true,
        id: rule.id,
        name: ruleBefore?.name,
        hard: rule.hard,
        human_message,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
