// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { readMemoryHandler, updateMemoryHandler, restoreMemoryHandler } from "@pathrule/core/tools/memories.js";
import { resolveRefreshHandler } from "@pathrule/core/tools/refreshes.js";
import { cacheInvalidate } from "../cache.js";
import { rerenderClaudeMdAfterWrite, resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import { prepareRelatedPaths } from "../lib/memory-context-paths.js";
import { contentEditSchema } from "./content-edit-schema.js";
import { relatedToCheckField } from "../lib/write-hint.js";
import type { ContentEdit } from "@pathrule/core/tools/content-edit.js";
import type { ToolDef } from "./types.js";
import { atomCaptureSentence, atomsInputSchema, captureAtomsForMemory, captureForWrite } from "./grounded-atoms.js";
import type { GroundedAtomClaim } from "@pathrule/agent-ir/atoms/grounded-capture.js";

interface Args {
  memory_id: string;
  content?: string;
  content_edit?: ContentEdit;
  title?: string;
  expected_version_id?: string;
  move_to_path?: string;
  refresh_id?: string;
  refresh_note?: string;
  verbose?: boolean;
  restore?: boolean;
  allow_duplicate?: boolean;
  related_paths?: string[] | null;
  atoms?: GroundedAtomClaim[];
}

export const updateMemoryTool: ToolDef<Args> = {
  name: "pathrule_update_memory",
  title: "Update Memory",
  description:
    "Update an existing memory, OR restore a soft-deleted one. For an update, pass `content` (and optionally `title`, `move_to_path`, `related_paths`); `related_paths` alone is a valid update. Pass `expected_version_id` from a prior read to detect concurrent edits; on mismatch it returns { error: 'conflict', detail: { current_version_id } } so you can re-read and merge; a change that lands between this call's own read and its write is reported the same way. Optional `move_to_path` relocates the memory (missing nodes auto-create). To restore a deleted memory, pass `restore: true` (content not required). After calling, relay the returned `human_message` to the user; do NOT paste raw tool JSON. Default response is compact (`{ id, human_message }`); pass `verbose: true` to get the full updated memory back.",
  inputSchema: {
    memory_id: z.string().uuid().describe("Memory UUID."),
    content: z
      .string()
      .optional()
      .describe(
        "New memory body (markdown), full replacement. Required unless `restore: true`, `content_edit`, or a title-only change. Prefer `content_edit` for small changes.",
      ),
    content_edit: contentEditSchema.optional(),
    restore: z
      .boolean()
      .optional()
      .describe(
        "Restore a soft-deleted memory (sets deleted_at = null). When true, content/title/move_to_path are ignored.",
      ),
    title: z.string().max(200).optional().describe("New title. Omit to keep the current title."),
    expected_version_id: z
      .string()
      .uuid()
      .optional()
      .describe("Optimistic concurrency token from a prior read."),
    move_to_path: z
      .string()
      .optional()
      .describe(
        "Optional — workspace-relative target path (e.g. '/apps/mobile'). Missing nodes auto-create. Combine with `content` to move+edit atomically.",
      ),
    refresh_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Pathrule refresh task UUID from pathrule_get_refresh_brief — when set, this update auto-resolves that task (status='applied'). Skips a separate pathrule_resolve_refresh call.",
      ),
    refresh_note: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Optional short note paired with refresh_id, stored with the resolved refresh task.",
      ),
    verbose: z
      .boolean()
      .optional()
      .describe(
        "Set to true to receive the full updated memory in the response. Default false (compact response).",
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe(
        "When omitted/false, a title rename or move that would collide with an existing memory's normalised title is rejected with code 'duplicate'. Set to true only after reviewing the existing memory.",
      ),
    related_paths: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Optional list of workspace-relative paths this memory is also relevant to (secondary links; the memory stays at its own path). null or omitted = unchanged (do not touch existing links). A list replaces the links. Pass an empty array [] to clear all manual links. Max 32 entries.",
      ),
    atoms: atomsInputSchema,
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext();

      if (args.restore) {
        const r = await restoreMemoryHandler(ctx, { memory_id: args.memory_id });
        if (!r.ok) return formatToolError(r.error);
        await Promise.all([
          cacheInvalidate({ workspaceId: "__by_id__", kind: "memory", id: r.data.id }),
          cacheInvalidate({ workspaceId: "__by_node__", kind: "memory-list", id: r.data.nodeId }),
          cacheInvalidate({ workspaceId: r.data.workspaceId, kind: "context", id: "__root__" }),
        ]);
        await rerenderClaudeMdAfterWrite(ctx, r.data.workspaceId);
        return { ok: true, id: r.data.id, restored: true, human_message: "Memory restored." };
      }

      // null or omitted keeps the stored links; an array (even empty) is a change of them.
      const preparedPaths = prepareRelatedPaths(args.related_paths);
      if (
        typeof args.content !== "string" &&
        !args.content_edit &&
        args.title === undefined &&
        args.move_to_path === undefined &&
        preparedPaths === null
      ) {
        // `atoms` alone types an existing memory's knowledge without changing its body.
        if (args.atoms && args.atoms.length > 0) {
          const current = await readMemoryHandler(ctx, { memory_id: args.memory_id });
          if (!current.ok) return formatToolError(current.error);
          const m = current.data;
          const atoms = await captureAtomsForMemory(ctx, m.workspaceId, { id: m.id, title: m.title, content: m.content }, args.atoms);
          await rerenderClaudeMdAfterWrite(ctx, m.workspaceId);
          return { ok: true, id: m.id, title: m.title, atoms, human_message: `Typed the memory "${m.title}".${atomCaptureSentence(atoms)}` };
        }
        return formatToolError({
          code: "invalid_args",
          message:
            "Provide content, content_edit, title, move_to_path, related_paths or atoms (or restore:true).",
        });
      }

      const result = await updateMemoryHandler(ctx, {
        memory_id: args.memory_id,
        content: args.content,
        content_edit: args.content_edit,
        title: args.title,
        expected_version_id: args.expected_version_id,
        move_to_path: args.move_to_path,
        allow_duplicate: args.allow_duplicate,
        ...(preparedPaths !== null ? { related_paths: preparedPaths } : {}),
      });
      if (!result.ok) return formatToolError(result.error);

      const memory = result.data;
      // Proved against the body as stored after this update; before the re-render, so the index carries them.
      // A body change types the new body (`captureForWrite`); a title or link change leaves the atoms as they are.
      const target = { id: memory.id, title: memory.title, content: memory.content };
      const atoms = args.content !== undefined || args.content_edit !== undefined
        ? await captureForWrite(ctx, memory.workspaceId, target, args.atoms)
        : await captureAtomsForMemory(ctx, memory.workspaceId, target, args.atoms);
      await Promise.all([
        cacheInvalidate({ workspaceId: "__by_id__", kind: "memory", id: args.memory_id }),
        cacheInvalidate({ workspaceId: "__by_node__", kind: "memory-list", id: memory.nodeId }),
        cacheInvalidate({ workspaceId: memory.workspaceId, kind: "context", id: "__root__" }),
      ]);
      await rerenderClaudeMdAfterWrite(ctx, memory.workspaceId);

      // The declared links were stored with the update.
      const storedPaths = memory.relatedPaths ?? [];

      let refreshResolved: { id: string; status: string } | null = null;
      if (args.refresh_id) {
        const r = await resolveRefreshHandler(ctx, {
          refresh_id: args.refresh_id,
          status: "applied",
          note: args.refresh_note,
        });
        if (r.ok) refreshResolved = { id: r.data.id, status: r.data.status };
      }

      const contextPathsFields = preparedPaths !== null ? { related_paths: storedPaths } : {};
      const baseHuman = args.move_to_path
        ? `Updated the memory "${memory.title}" and moved it to ${args.move_to_path}.`
        : `Updated the memory "${memory.title}".`;
      const human_message = (refreshResolved
        ? `${baseHuman} Refresh task ${refreshResolved.id} marked applied.`
        : baseHuman) + atomCaptureSentence(atoms);
      const atomFields = atoms ? { atoms } : {};
      return args.verbose
        ? {
            ok: true,
            memory: result.data,
            ...contextPathsFields,
            refresh_resolved: refreshResolved,
            ...relatedToCheckField(memory.workspaceId, memory.id),
            ...atomFields,
            human_message,
          }
        : {
            ok: true,
            id: memory.id,
            // The record's CURRENT title, even when this call did not set one. A
            // `content_edit` update names nothing in its arguments, so without this the
            // only thing any reader downstream (Studio's "learned this session" rows,
            // another editor's tool log) could say is "a memory was updated".
            title: memory.title,
            version_id: memory.versionId,
            ...contextPathsFields,
            refresh_resolved: refreshResolved,
            ...relatedToCheckField(memory.workspaceId, memory.id),
            ...atomFields,
            human_message,
          };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
