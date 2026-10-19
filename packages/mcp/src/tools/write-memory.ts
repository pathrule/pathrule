// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { writeMemoryHandler } from "@pathrule/core/tools/memories.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveWorkspaceTarget } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import { prepareRelatedPaths } from "../lib/memory-context-paths.js";
import type { ToolDef } from "./types.js";
import { atomCaptureSentence, atomsInputSchema, captureForWrite } from "./grounded-atoms.js";
import type { GroundedAtomClaim } from "@pathrule/agent-ir/atoms/grounded-capture.js";

interface Args {
  workspace_id?: string;
  cwd?: string;
  node_path: string;
  title: string;
  content: string;
  verbose?: boolean;
  allow_duplicate?: boolean;
  related_paths?: string[] | null;
  atoms?: GroundedAtomClaim[];
}

export const writeMemoryTool: ToolDef<Args> = {
  name: "pathrule_write_memory",
  title: "Write Memory",
  description:
    "Create a memory at a workspace path (missing nodes auto-create). Pass `workspace_id` (from the hook's session metadata or pathrule_get_context) or `cwd`; never invent a UUID. Target the most specific `node_path` the content belongs to (e.g. `/apps/mobile`). A memory whose normalised title already exists at that path is rejected unless `allow_duplicate: true`. Relay the returned `human_message` to the user in natural language, never raw JSON. The response is compact (`{ id, created_at, human_message }`); `verbose: true` returns the full record.",
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
        "Workspace-relative path like '/apps/mobile' or '/src/components/Button.tsx'. '/' means the workspace root. Missing folders/files auto-create.",
      ),
    title: z.string().min(1).max(200).describe("Short memory title."),
    content: z.string().min(1).describe("Memory body (markdown)."),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full memory row in the response. Default false (compact response).",
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        "When omitted/false, the write is rejected with code 'duplicate' if a memory with the same normalised title already exists at this node. Set to true only after reviewing the existing memory and deciding a separate record is warranted.",
      ),
    related_paths: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Optional list of workspace-relative paths this memory is also relevant to (e.g. ['/packages/shared/src/ipc-channels.ts', '/packages/app/electron/services']). They are secondary links: the memory still lives at `node_path`, and it is also offered for work under each link. Paths are validated and normalized; the root '/' and '..' are rejected. null or omitted = no context-path links set. Max 32 entries.",
      ),
    atoms: atomsInputSchema,
  },
  handler: async (args) => {
    try {
      const target = await resolveWorkspaceTarget(args);
      if (!target.ok) return formatToolError(target.error);
      const ctx = target.ctx;
      // The links travel with the write: the backend stores them in every edition.
      const preparedPaths = prepareRelatedPaths(args.related_paths);
      const result = await writeMemoryHandler(ctx, {
        node_path: args.node_path,
        title: args.title,
        content: args.content,
        source: "claude",
        allow_duplicate: args.allow_duplicate,
        ...(preparedPaths !== null ? { related_paths: preparedPaths } : {}),
      });
      if (!result.ok) return formatToolError(result.error);

      await Promise.all([
        cacheInvalidate({
          workspaceId: "__by_node__",
          kind: "memory-list",
          id: result.data.nodeId,
        }),
        cacheInvalidate({ workspaceId: result.data.workspaceId, kind: "context", id: "__root__" }),
      ]);
      // Record active paths for prior_solutions enrichment (best-effort).
      // Via the backend (account: change_log; local: activity_logs).
      ctx.backend
        ?.recordMemoryContextPaths(result.data.id, result.data.workspaceId)
        .catch(() => {});

      // The declared links are stored with the write.
      const storedPaths = result.data.relatedPaths ?? [];

      // Before the re-render, so the refreshed hook index already carries the new atoms.
      const atoms = await captureForWrite(ctx, result.data.workspaceId, { id: result.data.id, title: result.data.title, content: result.data.content }, args.atoms);

      await rerenderClaudeMdAfterWrite(ctx, result.data.workspaceId);

      const warnings = result.warnings ?? [];
      const similar = warnings.find((w) => w.code === "similar_titles");
      const similarSuffix = similar
        ? ` Note: this node already has memories with similar titles — review before relying on this one. See response.warnings.`
        : "";
      const human_message = `Saved memory "${result.data.title}" at ${args.node_path}.${similarSuffix} It'll show up in Pathrule within a few seconds.${atomCaptureSentence(atoms)}`;
      const contextPathsFields = preparedPaths !== null ? { related_paths: storedPaths } : {};
      const atomFields = atoms ? { atoms } : {};
      const body = args.verbose
        ? { ok: true, memory: result.data, ...contextPathsFields, ...atomFields, human_message }
        : {
            ok: true,
            id: result.data.id,
            // The stored title, so a reader downstream can name the record without a
            // second read (see update-memory).
            title: result.data.title,
            created_at: result.data.createdAt,
            ...contextPathsFields,
            ...atomFields,
            human_message,
          };
      return warnings.length > 0 ? { ...body, warnings } : body;
    } catch (e) {
      return formatThrown(e);
    }
  },
};
