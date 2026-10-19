// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { writeSkillHandler } from "@pathrule/core/tools/skills.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id?: string;
  cwd?: string;
  node_path: string;
  name: string;
  description?: string | null;
  content: string;
  source?: "manual" | "template" | "github_ref";
  github_url?: string | null;
  tags?: string[];
  verbose?: boolean;
}

export const writeSkillTool: ToolDef<Args> = {
  name: "pathrule_write_skill",
  title: "Write Skill",
  description:
    "Create a new skill (pass EITHER `workspace_id` OR `cwd`; with neither the server resolves the workspace from its own working directory) (a reusable checklist/pattern/template) at a workspace path. Missing nodes along the path auto-create. The `content` field should be a complete SKILL.md body — frontmatter + markdown. Use source='github_ref' + github_url when referencing an external skill package (e.g. anthropic/skills or skills.sh ecosystem). Content history is logged by database triggers. Skill names are unique per workspace — if the workspace already has a skill with this name (case- and punctuation-insensitive), the write is rejected with code 'duplicate'; in that case call update_skill on the existing record or pick a different name. After calling, relay the returned `human_message` in natural language — do NOT paste raw tool JSON or the full SKILL.md body back. Default response is compact (`{ id, created_at, human_message }`); pass `verbose: true` to get the full skill record back.",
  inputSchema: {
    workspace_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The workspace UUID from pathrule_get_context or the UserPromptSubmit hook metadata. Optional: omit it and pass `cwd` instead (or neither, and the server uses its own working directory) and the workspace is resolved from the folder. Never guess a UUID — a node id is not a workspace id.",
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Absolute working directory, used to resolve the workspace when `workspace_id` is omitted. Defaults to the MCP process's cwd.",
      ),
    node_path: z
      .string()
      .describe("Workspace-relative path the skill attaches to. Missing folders auto-create."),
    name: z.string().min(1).max(120).describe("Skill name (matches frontmatter.name)."),
    description: z
      .string()
      .max(300)
      .optional()
      .nullable()
      .describe("One-sentence summary for the skill index (matches frontmatter.description)."),
    content: z
      .string()
      .min(1)
      .describe(
        "Full SKILL.md body (frontmatter + markdown). If you author via the skill-creator pattern, paste the full artifact here.",
      ),
    source: z
      .enum(["manual", "template", "github_ref"])
      .optional()
      .describe(
        "'manual' (default) = content is authoritative; 'github_ref' = content is fetched from github_url on read; 'template' reserved for the built-in template library.",
      ),
    github_url: z
      .string()
      .url()
      .optional()
      .nullable()
      .describe("Required when source='github_ref'. Raw-content URL preferred."),
    tags: z.array(z.string()).max(10).optional().describe("Kebab-case tags, up to 10."),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full skill row in the response. Default false (compact response).",
      ),
  },
  handler: async (args) => {
    try {
      const target = await resolveWorkspaceTarget(args);
      if (!target.ok) return formatToolError(target.error);
      const ctx = target.ctx;
      const result = await writeSkillHandler(ctx, {
        node_path: args.node_path,
        name: args.name,
        description: args.description ?? null,
        content: args.content,
        source: args.source,
        github_url: args.github_url,
        tags: args.tags,
      });
      if (!result.ok) return formatToolError(result.error);

      await cacheInvalidate({
        workspaceId: result.data.workspaceId,
        kind: "context",
        id: "__root__",
      });
      await rerenderClaudeMdAfterWrite(ctx, result.data.workspaceId);

      const human_message = `Created skill "${result.data.name}" at ${args.node_path} (source: ${result.data.source}).`;
      return args.verbose
        ? { ok: true, skill: result.data, human_message }
        : {
            ok: true,
            id: result.data.id,
            // The stored name (see update-memory).
            name: result.data.name,
            created_at: result.data.createdAt,
            human_message,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
