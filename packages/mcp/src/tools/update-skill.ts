// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { updateSkillHandler, restoreSkillHandler } from "@pathrule/core/tools/skills.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import { contentEditSchema } from "./content-edit-schema.js";
import type { ContentEdit } from "@pathrule/core/tools/content-edit.js";
import type { ToolDef } from "./types.js";
import { relatedToCheckField } from "../lib/write-hint.js";

interface Args {
  skill_id: string;
  expected_version_id?: string;
  patch?: {
    name?: string;
    description?: string | null;
    content?: string;
    source?: "manual" | "template" | "github_ref";
    github_url?: string | null;
    tags?: string[];
  };
  content_edit?: ContentEdit;
  move_to_path?: string;
  verbose?: boolean;
  restore?: boolean;
}

export const updateSkillTool: ToolDef<Args> = {
  name: "pathrule_update_skill",
  title: "Update Skill",
  description:
    "Update an existing skill, OR restore a soft-deleted one. For an update, pass `patch` with the fields to change; can change any field including source (e.g. convert a github_ref skill to manual). Pass expected_version_id for conflict detection. Optional `move_to_path` re-attaches the skill. To restore a deleted skill, pass `restore: true` (patch not required). After calling, relay the returned `human_message` — do NOT paste raw tool JSON. Default response is compact (`{ id, human_message }`); pass `verbose: true` to get the full updated skill back.",
  inputSchema: {
    skill_id: z.string().uuid().describe("Skill UUID."),
    expected_version_id: z.string().uuid().optional().describe("Optimistic concurrency token."),
    patch: z
      .object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(300).nullable().optional(),
        content: z.string().optional(),
        source: z.enum(["manual", "template", "github_ref"]).optional(),
        github_url: z.string().url().nullable().optional(),
        tags: z.array(z.string()).max(10).optional(),
      })
      .optional()
      .describe(
        "Fields to change. Only provided fields are patched. Required unless restore:true or content_edit is used. For a small body change prefer `content_edit` over patch.content.",
      ),
    content_edit: contentEditSchema.optional(),
    restore: z
      .boolean()
      .optional()
      .describe(
        "Restore a soft-deleted skill (sets deleted_at = null). When true, patch/move_to_path are ignored.",
      ),
    move_to_path: z
      .string()
      .optional()
      .describe(
        "Optional — workspace-relative target path (e.g. '/apps/api'). Missing nodes auto-create.",
      ),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full updated skill in the response. Default false (compact response).",
      ),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();

      if (args.restore) {
        const r = await restoreSkillHandler(ctx, { skill_id: args.skill_id });
        if (!r.ok) return formatToolError(r.error);
        await Promise.all([
          cacheInvalidate({ workspaceId: "__by_id__", kind: "skill", id: r.data.id }),
          cacheInvalidate({ workspaceId: r.data.workspaceId, kind: "context", id: "__root__" }),
        ]);
        await rerenderClaudeMdAfterWrite(ctx, r.data.workspaceId);
        return { ok: true, id: r.data.id, restored: true, human_message: "Skill restored." };
      }

      if (!args.patch && !args.content_edit && !args.move_to_path) {
        return formatToolError({
          code: "invalid_args",
          message: "Provide patch, content_edit, or move_to_path (or restore:true).",
        });
      }

      const result = await updateSkillHandler(ctx, {
        skill_id: args.skill_id,
        expected_version_id: args.expected_version_id,
        patch: args.patch ?? {},
        content_edit: args.content_edit,
        move_to_path: args.move_to_path,
      });
      if (!result.ok) return formatToolError(result.error);

      const skill = result.data as {
        workspaceId: string;
        id: string;
        versionId: string;
        name: string;
      };
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "skill", id: args.skill_id }),
        cacheInvalidate({ workspaceId: skill.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, skill.workspaceId);
      const human_message = args.move_to_path
        ? `Updated the skill "${skill.name}" and moved it to ${args.move_to_path}.`
        : `Updated the skill "${skill.name}".`;
      return args.verbose
        ? { ok: true, skill: result.data, ...relatedToCheckField(skill.workspaceId, skill.id), human_message }
        : {
            ok: true,
            id: skill.id,
            // The skill's CURRENT name — a content_edit update names nothing in its
            // arguments (see update-memory).
            name: skill.name,
            version_id: skill.versionId,
            ...relatedToCheckField(skill.workspaceId, skill.id),
            human_message,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
