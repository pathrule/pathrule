// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { deleteSkillHandler } from "@pathrule/core/tools/skills.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  skill_id: string;
  hard?: boolean;
  expected_version_id?: string;
}

export const deleteSkillTool: ToolDef<Args> = {
  name: "pathrule_delete_skill",
  title: "Delete Skill",
  description:
    "Soft-delete a skill by id. The skill is hidden from every read path (lists, get_context, CLAUDE.md render) and will no longer materialize to disk on the next sync. Remains in the database for 30 days. To bring it back, call pathrule_update_skill with `restore: true`. Pass `hard: true` to permanently remove (workspace_admin only). After calling, relay the returned `human_message` to the user — do not paste raw tool JSON.",
  inputSchema: {
    skill_id: z.string().uuid().describe("Skill UUID."),
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
      // relay, Studio's "learned this session" rows) could only report that a skill
      // disappeared, never which. One extra read on a rare, deliberate operation.
      const skillBefore = await ctx.backend?.readSkill(args.skill_id).catch(() => null);
      const named = skillBefore?.name ? ` "${skillBefore.name}"` : "";
      const result = await deleteSkillHandler(ctx, {
        skill_id: args.skill_id,
        hard: args.hard,
        expected_version_id: args.expected_version_id,
      });
      if (!result.ok) return formatToolError(result.error);

      const skill = result.data;
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "skill", id: skill.id }),
        cacheInvalidate({ workspaceId: skill.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, skill.workspaceId);

      const human_message = skill.hard
        ? `Skill${named} permanently deleted.`
        : `Skill${named} deleted. Use pathrule_update_skill with restore:true to bring it back.`;
      return {
        ok: true,
        id: skill.id,
        name: skillBefore?.name,
        hard: skill.hard,
        human_message,
      };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
