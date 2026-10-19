// SPDX-License-Identifier: Apache-2.0
//
// Memory tool handlers — reads in Phase 5, writes in Phase 6.

import type { ToolContext, ToolError, ToolResult, ToolWarning } from "./types.js";
import { DEMO_READONLY_MESSAGE, mapStoreError, mapRpcError } from "./types.js";
import type { Memory, MemorySource } from "@pathrule/protocol/content-types.js";
import type { DedupSimilarEntry } from "@pathrule/protocol/dedup-types.js";
import type { ContentEdit } from "./content-edit.js";
import { resolveEditedContent } from "./edit-resolution.js";
import { normalizeNodePath } from "./node-path.js";
import { isRelatedPathsError, normalizeRelatedPaths } from "../backend/memory-links.js";

export interface ListMemoriesArgs {
  node_id: string;
}

export async function listMemoriesHandler(
  ctx: ToolContext,
  args: ListMemoriesArgs,
): Promise<ToolResult<Memory[]>> {
  // Node-scoped list through the backend. The node carries its workspace,
  // so we resolve it via getNode rather than threading a workspaceId the caller lacks.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const node = await ctx.backend.getNode(args.node_id);
    if (!node) return { ok: true, data: [] };
    const memories = await ctx.backend.listMemories({
      workspaceId: node.workspaceId,
      nodeId: node.id,
    });
    return { ok: true, data: memories };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface ReadMemoryArgs {
  memory_id: string;
}

export async function readMemoryHandler(
  ctx: ToolContext,
  args: ReadMemoryArgs,
): Promise<ToolResult<Memory & { nodeRelativePath: string | null }>> {
  // Read through the injected backend. The node path is resolved via
  // backend.getNode. Errors thrown by the
  // backend are mapped back to the handler's ToolResult contract here.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const memory = await ctx.backend.readMemory(args.memory_id);
    if (!memory) {
      return {
        ok: false,
        error: { code: "not_found", message: `Memory ${args.memory_id} not found` },
      };
    }
    const node = memory.nodeId ? await ctx.backend.getNode(memory.nodeId) : null;
    return { ok: true, data: { ...memory, nodeRelativePath: node?.relativePath ?? null } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Writes (M8.7 path-first: tools take node_path, auto-materialise the chain)
// -----------------------------------------------------------------------------

export interface WriteMemoryArgs {
  /** Workspace-relative path like "/apps/mobile". Missing nodes auto-create as folders/files. */
  node_path: string;
  title: string;
  content: string;
  /** Defaults to 'claude' when the caller is the MCP. */
  source?: MemorySource;
  /**
   * When false (default), insert is blocked if a memory with the same
   * normalised title already exists at this node. Pass true after the caller
   * has reviewed the conflict and still wants to create a separate record.
   */
  allow_duplicate?: boolean;
  /**
   * Secondary context links: workspace paths the memory is also relevant to. Omitted or `[]`:
   * none. Never a second owner (`node_path` is the owner). See backend/memory-links.ts.
   */
  related_paths?: string[];
}

/**
 * A written or updated memory, plus the links this call stored, canonical and sorted. `relatedPaths`
 * is absent when the call did not set links (an update that keeps them reports nothing about them).
 */
export type MemoryWriteResult = Memory & { relatedPaths?: string[] };

/** Validate `related_paths` against the owner path before anything is written. */
function preparedLinks(
  raw: string[] | undefined,
  ownerPath: string,
): { ok: true; links: string[] | undefined } | { ok: false; error: ToolError } {
  if (raw === undefined) return { ok: true, links: undefined };
  try {
    return { ok: true, links: normalizeRelatedPaths(raw, ownerPath) };
  } catch (err) {
    if (isRelatedPathsError(err)) {
      return { ok: false, error: { code: "invalid_args", message: err.message } };
    }
    throw err;
  }
}

function similarTitlesWarning(similar: DedupSimilarEntry[]): ToolWarning | null {
  if (similar.length === 0) return null;
  return {
    code: "similar_titles",
    message: `Found ${similar.length} memory/rule(s) with a similar title.`,
    detail: { similar },
  };
}

export async function writeMemoryHandler(
  ctx: ToolContext,
  args: WriteMemoryArgs,
): Promise<ToolResult<MemoryWriteResult>> {
  if (!ctx.workspaceId) {
    return {
      ok: false,
      error: { code: "invalid_args", message: "ctx.workspaceId is required for path-based writes" },
    };
  }
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Full write composed on backend primitives: demo-guard → path
  // materialisation → dedup → insert. Each step is a backend method; the policy
  // (block on duplicate, surface similar-title warning) stays here in the handler.
  try {
    if (await ctx.backend.isDemoWorkspace(ctx.workspaceId)) {
      return { ok: false, error: { code: "permission_denied", message: DEMO_READONLY_MESSAGE } };
    }
    // Before the path is materialised: a rejected link list must not leave new nodes behind.
    const links = preparedLinks(args.related_paths, normalizeNodePath(args.node_path));
    if (!links.ok) return { ok: false, error: links.error };
    const node = await ctx.backend.ensureNodeForPath(ctx.workspaceId, args.node_path);

    const candidate = args.title.trim();
    const dedup = await ctx.backend.checkContentDedup({
      workspaceId: node.workspace_id,
      kind: "memory",
      nodeId: node.id,
      candidate,
    });
    if (dedup.duplicate && !args.allow_duplicate) {
      return {
        ok: false,
        error: {
          code: "duplicate",
          message: `A memory titled "${dedup.duplicate.title}" already exists at ${args.node_path}. Use update_memory, pick a different title, or pass allow_duplicate: true to insert anyway.`,
          detail: {
            existing_id: dedup.duplicate.id,
            existing_title: dedup.duplicate.title,
            similar: dedup.similar,
          },
        },
      };
    }

    const memory = await ctx.backend.writeMemory({
      workspaceId: node.workspace_id,
      nodeId: node.id,
      title: candidate,
      content: args.content,
      source: args.source,
      ...(links.links !== undefined ? { relatedPaths: links.links } : {}),
    });
    const data: MemoryWriteResult =
      links.links !== undefined ? { ...memory, relatedPaths: links.links } : memory;

    const warning = similarTitlesWarning(dedup.similar);
    return warning ? { ok: true, data, warnings: [warning] } : { ok: true, data };
  } catch (err) {
    return { ok: false, error: mapWriteError(err) };
  }
}

/** A backend's refusal, as the tool reports it. A rejected link list is the caller's input. */
function mapWriteError(err: unknown): ToolError {
  if (isRelatedPathsError(err)) {
    return { code: "invalid_args", message: (err as Error).message };
  }
  return mapStoreError(err as { code?: string; message: string });
}

function isVersionConflict(err: unknown): boolean {
  return (err as { message?: unknown } | null)?.message === "content_version_conflict";
}

export interface UpdateMemoryArgs {
  memory_id: string;
  /** Full replacement body. Omit when using `content_edit` (a surgical delta) or changing only the title. */
  content?: string;
  /** Surgical delta applied server-side to the current body — avoids resending the whole content. */
  content_edit?: ContentEdit;
  /** New title. Omit to keep the current title. */
  title?: string;
  /** Optimistic concurrency token from a prior read. */
  expected_version_id?: string;
  /**
   * Optional — move the memory to a different node in the same call. Missing
   * nodes along the path auto-create. Combine with `content` to move+edit atomically.
   */
  move_to_path?: string;
  /** Bypass duplicate-title check on title rename / move (see writeMemoryHandler). */
  allow_duplicate?: boolean;
  /** Secondary context links: omitted keeps them, `[]` clears them, a list replaces them. */
  related_paths?: string[];
}

export async function updateMemoryHandler(
  ctx: ToolContext,
  args: UpdateMemoryArgs,
): Promise<ToolResult<MemoryWriteResult>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Composed on backend primitives. Conflict + dedup + move policy stays
  // in the handler; backend.updateMemory bumps the version with its own optimistic
  // double-guard and re-homes the node when nodeId is supplied.
  try {
    const current = await ctx.backend.readMemory(args.memory_id);
    if (!current) {
      return {
        ok: false,
        error: { code: "not_found", message: `Memory ${args.memory_id} not found` },
      };
    }

    if (args.expected_version_id && current.versionId !== args.expected_version_id) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Memory has been modified since you last read it.",
          detail: { current_version_id: current.versionId },
        },
      };
    }

    // Resolve the final body: a surgical `content_edit` applies against the
    // authoritative current body; otherwise `content` (full) is used as-is.
    const resolved = resolveEditedContent({
      currentContent: current.content,
      content: args.content,
      contentEdit: args.content_edit,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const finalContent = resolved.content;

    // Links are validated against the owner they will have, before a move materialises nodes.
    let links: { ok: true; links: string[] | undefined } | { ok: false; error: ToolError } = {
      ok: true,
      links: undefined,
    };
    if (args.related_paths !== undefined) {
      const ownerPath = args.move_to_path
        ? normalizeNodePath(args.move_to_path)
        : current.nodeId
          ? ((await ctx.backend.getNode(current.nodeId))?.relativePath ?? "/")
          : "/";
      links = preparedLinks(args.related_paths, ownerPath);
      if (!links.ok) return { ok: false, error: links.error };
    }

    let targetNodeId = current.nodeId;
    if (args.move_to_path) {
      const target = await ctx.backend.ensureNodeForPath(current.workspaceId, args.move_to_path);
      targetNodeId = target.id;
    }

    const titleChanged = args.title !== undefined && args.title.trim() !== current.title;
    const nodeChanged = targetNodeId !== current.nodeId;
    if ((titleChanged || nodeChanged) && !args.allow_duplicate) {
      const finalTitle = (args.title ?? current.title).trim();
      const dedup = await ctx.backend.checkContentDedup({
        workspaceId: current.workspaceId,
        kind: "memory",
        nodeId: targetNodeId,
        candidate: finalTitle,
        excludeId: args.memory_id,
        maxSimilar: 0,
      });
      if (dedup.duplicate) {
        return {
          ok: false,
          error: {
            code: "duplicate",
            message: `A memory titled "${dedup.duplicate.title}" already exists at this node. Pick a different title or pass allow_duplicate: true.`,
            detail: {
              existing_id: dedup.duplicate.id,
              existing_title: dedup.duplicate.title,
            },
          },
        };
      }
    }

    // Every field written here was decided from `current` (a content_edit's body above all), so
    // the write is guarded by the version that was read: a change that landed in between is a
    // conflict, never silently overwritten. The caller's own token, when given, is the same check.
    const expectedVersionId = args.expected_version_id ?? current.versionId;
    let updated: Memory;
    try {
      updated = await ctx.backend.updateMemory({
        id: args.memory_id,
        expectedVersionId,
        content: finalContent,
        title: args.title ? args.title.trim() : undefined,
        nodeId: nodeChanged ? targetNodeId : undefined,
        ...(links.links !== undefined ? { relatedPaths: links.links } : {}),
      });
    } catch (err) {
      if (!isVersionConflict(err)) throw err;
      const latest = await ctx.backend.readMemory(args.memory_id);
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Memory has been modified since you last read it.",
          detail: { current_version_id: latest?.versionId ?? null },
        },
      };
    }
    const data: MemoryWriteResult =
      links.links !== undefined ? { ...updated, relatedPaths: links.links } : updated;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: mapWriteError(err) };
  }
}

export interface DeleteMemoryArgs {
  memory_id: string;
  /** Default false (soft delete). True requires workspace_admin. */
  hard?: boolean;
  /** Optimistic concurrency token from a prior read. */
  expected_version_id?: string;
}

export interface DeleteMemoryResult {
  id: string;
  workspaceId: string;
  nodeId: string;
  hard: boolean;
}

export async function deleteMemoryHandler(
  ctx: ToolContext,
  args: DeleteMemoryArgs,
): Promise<ToolResult<DeleteMemoryResult>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Soft/hard delete + optimistic conflict live in backend.deleteMemory,
  // which returns a discriminated outcome the handler maps to its ToolResult contract.
  try {
    const res = await ctx.backend.deleteMemory({
      id: args.memory_id,
      hard: args.hard,
      expectedVersionId: args.expected_version_id,
    });
    if (res.status === "rejected") {
      return { ok: false, error: mapRpcError(res.reason) };
    }
    if (res.status === "conflict") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Memory has been modified since you last read it.",
          detail: { current_version_id: res.currentVersionId },
        },
      };
    }
    return {
      ok: true,
      data: {
        id: res.id,
        workspaceId: res.workspaceId,
        nodeId: res.nodeId ?? "",
        hard: !!args.hard,
      },
    };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface RestoreMemoryArgs {
  memory_id: string;
}

export async function restoreMemoryHandler(
  ctx: ToolContext,
  args: RestoreMemoryArgs,
): Promise<ToolResult<{ id: string; workspaceId: string; nodeId: string }>> {
  // Restore (archived → active) owned by the backend (cloud: restore_memory_rpc;
  // local: status flip). The rejected reason carries the rpc error string for mapRpcError.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const res = await ctx.backend.restoreMemory(args.memory_id);
    if (res.status === "rejected") return { ok: false, error: mapRpcError(res.reason) };
    return {
      ok: true,
      data: { id: res.id, workspaceId: res.workspaceId, nodeId: res.nodeId ?? "" },
    };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}
