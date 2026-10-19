// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { updateRuleHandler, restoreRuleHandler } from "@pathrule/core/tools/rules.js";
import { resolveRefreshHandler } from "@pathrule/core/tools/refreshes.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import { contentEditSchema } from "./content-edit-schema.js";
import type { ContentEdit } from "@pathrule/core/tools/content-edit.js";
import type { StructuredConstraintIntent } from "@pathrule/agent-ir/atoms/constraint-compiler.js";
import type { ToolDef } from "./types.js";
import { relatedToCheckField } from "../lib/write-hint.js";

interface Args {
  rule_id: string;
  expected_version_id?: string;
  patch?: {
    name?: string;
    content?: string;
    scope_type?: "folder" | "file_type" | "project";
    priority?: "high" | "medium" | "low";
    constraint?: { mode: "forbid"; pattern: string; flags?: string; message: string };
    constraint_intent?: StructuredConstraintIntent;
    check?: { scope_path: string; command: string; message: string };
  };
  content_edit?: ContentEdit;
  move_to_path?: string;
  refresh_id?: string;
  refresh_note?: string;
  verbose?: boolean;
  restore?: boolean;
  allow_duplicate?: boolean;
}

export const updateRuleTool: ToolDef<Args> = {
  name: "pathrule_update_rule",
  title: "Update Rule",
  description:
    "Update an existing rule, OR restore a soft-deleted one. For an update, pass `patch` with the fields to change; pass expected_version_id to detect concurrent edits. Optional `move_to_path` re-attaches the rule to a different path. To restore a deleted rule, pass `restore: true` (patch not required). After calling, relay the returned `human_message` — do NOT paste raw tool JSON. Default response is compact (`{ id, human_message }`); pass `verbose: true` to get the full updated rule back.",
  inputSchema: {
    rule_id: z.string().uuid().describe("Rule UUID."),
    expected_version_id: z.string().uuid().optional().describe("Optimistic concurrency token."),
    patch: z
      .object({
        name: z.string().min(1).max(120).optional(),
        content: z.string().optional(),
        scope_type: z.enum(["folder", "file_type", "project"]).optional(),
        priority: z.enum(["high", "medium", "low"]).optional(),
        constraint: z
          .object({
            mode: z.literal("forbid"),
            pattern: z.string().min(3).max(200),
            flags: z.string().optional(),
            message: z.string().min(10),
          })
          .optional()
          .describe(
            "Attach an executable constraint. Stored as a PROPOSAL (authority: inferred, status: proposed) and NOT enforced; a person must approve it separately before the runtime blocks anything.",
          ),
        constraint_intent: z
          .object({
            source_text: z
              .string()
              .min(1)
              .describe(
                "The excerpt of THIS rule's body the ban is taken from. Every literal below must appear in it verbatim; that is what stops a prohibition nobody wrote from being compiled.",
              ),
            forbidden_forms: z
              .array(
                z.object({
                  literal: z
                    .string()
                    .min(1)
                    .describe("The forbidden text, spelled exactly as the rule body spells it."),
                  form_kind: z
                    .enum([
                      "character",
                      "identifier",
                      "code_fragment",
                      "class_name",
                      "css_declaration",
                      "import_specifier",
                    ])
                    .describe(
                      "What KIND of thing the literal is. The compiler derives the mechanical variations from this (whitespace, quoting, camelCase spelling of a CSS property, import syntax and subpaths), which is why you must not write a regex.",
                    ),
                }),
              )
              .min(0)
              .max(12)
              .describe(
                "The forbidden literals. Leave empty for a path-only constraint, where the violation is WHERE the file is rather than what it contains.",
              ),
            positive_examples: z
              .array(z.string())
              .describe(
                "Real code (or, for a path-only constraint, workspace-relative paths) that MUST be caught. Every single one has to match or nothing compiles.",
              ),
            negative_examples: z
              .array(z.string())
              .describe(
                "Near-miss code or paths that must NOT be caught. One false positive and nothing compiles.",
              ),
            message: z
              .string()
              .min(10)
              .describe("What to do instead. Shown to the agent when an edit is blocked."),
            scope_path: z
              .string()
              .optional()
              .describe(
                'Optional path narrowing, e.g. "/packages/mobile/Pathrule". With forbidden_forms it is an AND; alone it makes the path itself the violation.',
              ),
            file_extensions: z
              .array(z.string())
              .optional()
              .describe('Optional extension filter for the narrowing, e.g. [".md"].'),
          })
          .optional()
          .describe(
            "Optional executable constraint expressed as STRUCTURED INTENT rather than a regex. The deterministic compiler builds the pattern from the literal plus its form kind and then verifies it against your examples in both directions; if either oracle fails the write is REFUSED with the reason, never weakened. Stored as a PROPOSAL (status: proposed) from this surface: a person approves it before anything is enforced. Replaces any previously compiled active constraint on this rule rather than accumulating one.",
          ),
        check: z
          .object({
            scope_path: z.string(),
            command: z.string().min(3).max(300),
            message: z.string().min(10),
          })
          .optional()
          .describe(
            "Attach an executable check: a verification that must have passed before a turn under `scope_path` can finish. Stored as a PROPOSAL and NOT enforced until a person approves it.",
          ),
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
        "Restore a soft-deleted rule (sets deleted_at = null). When true, patch/move_to_path are ignored.",
      ),
    move_to_path: z
      .string()
      .optional()
      .describe(
        "Optional — workspace-relative target path (e.g. '/apps/api'). Missing nodes auto-create.",
      ),
    refresh_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Pathrule refresh task UUID from pathrule_get_refresh_brief — when set, this update auto-resolves that task.",
      ),
    refresh_note: z
      .string()
      .max(500)
      .optional()
      .describe("Optional note paired with refresh_id, stored with the resolved refresh task."),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full updated rule in the response. Default false (compact response).",
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        "When omitted/false, a rename that would collide with another rule's normalised name in the workspace is rejected with code 'duplicate'. Set to true only after reviewing the existing rule.",
      ),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();

      if (args.restore) {
        const r = await restoreRuleHandler(ctx, { rule_id: args.rule_id });
        if (!r.ok) return formatToolError(r.error);
        await Promise.all([
          cacheInvalidate({ workspaceId: "__by_id__", kind: "rule", id: r.data.id }),
          cacheInvalidate({ workspaceId: r.data.workspaceId, kind: "context", id: "__root__" }),
        ]);
        await rerenderClaudeMdAfterWrite(ctx, r.data.workspaceId);
        return { ok: true, id: r.data.id, restored: true, human_message: "Rule restored." };
      }

      if (!args.patch && !args.content_edit && !args.move_to_path) {
        return formatToolError({
          code: "invalid_args",
          message: "Provide patch, content_edit, or move_to_path (or restore:true).",
        });
      }

      const result = await updateRuleHandler(ctx, {
        rule_id: args.rule_id,
        expected_version_id: args.expected_version_id,
        patch: args.patch ?? {},
        // See write-rule: an agent-facing surface never claims explicit human policy, so
        // a compiled constraint from here lands proposed no matter what it contains.
        policy_provenance: "inferred",
        content_edit: args.content_edit,
        move_to_path: args.move_to_path,
        allow_duplicate: args.allow_duplicate,
      });
      if (!result.ok) return formatToolError(result.error);

      const rule = result.data as {
        workspaceId: string;
        id: string;
        versionId: string;
        name: string;
      };
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "rule", id: args.rule_id }),
        cacheInvalidate({ workspaceId: rule.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, rule.workspaceId);
      let refreshResolved: { id: string; status: string } | null = null;
      if (args.refresh_id) {
        const r = await resolveRefreshHandler(ctx, {
          refresh_id: args.refresh_id,
          status: "applied",
          note: args.refresh_note,
        });
        if (r.ok) refreshResolved = { id: r.data.id, status: r.data.status };
      }
      const baseHuman = args.move_to_path
        ? `Updated the rule "${rule.name}" and moved it to ${args.move_to_path}.`
        : `Updated the rule "${rule.name}".`;
      const human_message = refreshResolved
        ? `${baseHuman} Refresh task ${refreshResolved.id} marked applied.`
        : baseHuman;
      return args.verbose
        ? { ok: true, rule: result.data, refresh_resolved: refreshResolved, ...relatedToCheckField(rule.workspaceId, rule.id), human_message }
        : {
            ok: true,
            id: rule.id,
            // The rule's CURRENT name, so a patch/content_edit update is still
            // reportable as a named record downstream (see update-memory).
            name: rule.name,
            version_id: rule.versionId,
            refresh_resolved: refreshResolved,
            ...relatedToCheckField(rule.workspaceId, rule.id),
            human_message,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
