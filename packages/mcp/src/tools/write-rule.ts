// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { writeRuleHandler } from "@pathrule/core/tools/rules.js";
import type { StructuredConstraintIntent } from "@pathrule/agent-ir/atoms/constraint-compiler.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id?: string;
  cwd?: string;
  node_path: string;
  name: string;
  content: string;
  scope_type: "folder" | "file_type" | "project";
  priority: "high" | "medium" | "low";
  verbose?: boolean;
  allow_duplicate?: boolean;
  constraint?: { mode: "forbid"; pattern: string; flags?: string; message: string };
  constraint_intent?: StructuredConstraintIntent;
  check?: { scope_path: string; command: string; message: string };
}

export const writeRuleTool: ToolDef<Args> = {
  name: "pathrule_write_rule",
  title: "Write Rule",
  description:
    "Create a new rule (constraint) at a workspace path. Pass EITHER `workspace_id` OR `cwd`; with neither the server resolves the workspace from its own working directory. If the path's node doesn't exist yet, it's auto-created — you do NOT need to create nodes manually. High-priority rules should be used sparingly — they can cascade. Content history is logged by database triggers. By default the tool blocks if a rule with the same normalised name already exists in the workspace; pass `allow_duplicate: true` to force-insert after reviewing the conflict. After calling, relay the returned `human_message` in natural language — do NOT paste raw tool JSON. Default response is compact (`{ id, created_at, human_message }`); pass `verbose: true` to get the full rule record back.",
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
      .describe(
        "Workspace-relative path like '/apps/api'. Missing folders auto-create so you can target any depth.",
      ),
    name: z.string().min(1).max(120).describe("Short imperative rule name."),
    content: z.string().min(1).describe("Rule body (markdown, bullet form preferred)."),
    scope_type: z
      .enum(["folder", "file_type", "project"])
      .describe(
        "folder = applies under a specific directory; file_type = applies to a file glob; project = applies everywhere.",
      ),
    priority: z
      .enum(["high", "medium", "low"])
      .describe(
        "high = violations cause bugs/security/regressions; medium = default; low = stylistic.",
      ),
    constraint: z
      .object({
        mode: z.literal("forbid").describe("Only 'forbid' exists today."),
        pattern: z
          .string()
          .min(3)
          .max(200)
          .describe(
            "JavaScript regex source matched against the text of an Edit/Write. Must not match the empty string.",
          ),
        flags: z
          .string()
          .optional()
          .describe("Unique subset of 'ims'. 'g' and 'y' are rejected because they make .test() stateful."),
        message: z
          .string()
          .min(10)
          .describe("What to do instead. Shown to the agent when the edit is blocked."),
      })
      .optional()
      .describe(
        "Optional executable constraint. It is stored as a PROPOSAL (authority: inferred, status: proposed) and is NOT enforced. A person must approve it separately before the runtime will block anything.",
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
        "Optional executable constraint expressed as STRUCTURED INTENT rather than a regex. The deterministic compiler builds the pattern from the literal plus its form kind and then verifies it against your examples in both directions; if either oracle fails the write is REFUSED with the reason, never weakened. Stored as a PROPOSAL (status: proposed) from this surface: a person approves it before anything is enforced.",
      ),
    check: z
      .object({
        scope_path: z
          .string()
          .describe('Workspace-relative path the requirement applies under, e.g. "/packages/shared". Narrows the rule scope; it can never widen it.'),
        command: z
          .string()
          .min(3)
          .max(300)
          .describe('Verification command that must have passed, e.g. "pnpm --filter @pathrule/shared test". Must be a form the evidence channel canonicalises: no pipes, since a pipe moves the exit code off the command.'),
        message: z.string().min(10).describe("Why it is required and what to run. Shown to the agent when the turn is held open."),
      })
      .optional()
      .describe(
        "Optional executable CHECK. Stored as a PROPOSAL (authority: inferred, status: proposed) and NOT enforced. A person must approve it separately before a turn can be held open for it.",
      ),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full rule row in the response. Default false (compact response).",
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        "When omitted/false, the write is rejected with code 'duplicate' if a rule with the same normalised name already exists in this workspace. Set to true only after reviewing the existing rule.",
      ),
  },
  handler: async (args) => {
    try {
      const target = await resolveWorkspaceTarget(args);
      if (!target.ok) return formatToolError(target.error);
      const ctx = target.ctx;
      const result = await writeRuleHandler(ctx, {
        node_path: args.node_path,
        name: args.name,
        content: args.content,
        scope_type: args.scope_type,
        priority: args.priority,
        allow_duplicate: args.allow_duplicate,
        constraint: args.constraint,
        constraint_intent: args.constraint_intent,
        // Never forwarded from an agent-facing surface, and deliberately absent from the
        // schema above: `explicit` is the claim that a PERSON decided this ban, and an
        // agent asserting it about its own output is exactly the self-grant the authority
        // split exists to prevent. The compiler still runs; the atom lands proposed.
        policy_provenance: "inferred",
        check: args.check,
      });
      if (!result.ok) return formatToolError(result.error);

      await cacheInvalidate({
        workspaceId: result.data.workspaceId,
        kind: "context",
        id: "__root__",
      });
      await rerenderClaudeMdAfterWrite(ctx, result.data.workspaceId);

      const warnings = result.warnings ?? [];
      const similar = warnings.find((w) => w.code === "similar_titles");
      const similarSuffix = similar
        ? ` Note: this workspace already has rules with similar names — review before relying on this one. See response.warnings.`
        : "";
      const human_message = `Added ${result.data.priority}-priority rule "${result.data.name}" at ${args.node_path} (scope: ${result.data.scopeType}).${similarSuffix}`;
      const body = args.verbose
        ? { ok: true, rule: result.data, human_message }
        : {
            ok: true,
            id: result.data.id,
            // The stored name (see update-memory).
            name: result.data.name,
            created_at: result.data.createdAt,
            human_message,
          };
      return warnings.length > 0 ? { ...body, warnings } : body;
    } catch (e) {
      return formatThrown(e);
    }
  },
};
