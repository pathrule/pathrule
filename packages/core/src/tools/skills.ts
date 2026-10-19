// SPDX-License-Identifier: Apache-2.0
//
// Skill tool handlers — snapshot reads, package-compatible writes, path-first M8.7.

import type { ToolContext, ToolResult } from "./types.js";
import { DEMO_READONLY_MESSAGE, isSkillSlugUniqueViolation, mapStoreError, mapRpcError } from "./types.js";
import type { Skill, SkillSource } from "@pathrule/protocol/content-types.js";
import type { ContentEdit } from "./content-edit.js";
import { resolveEditedContent } from "./edit-resolution.js";

export interface ReadSkillArgs {
  skill_id: string;
}

export async function readSkillHandler(
  ctx: ToolContext,
  args: ReadSkillArgs,
): Promise<ToolResult<Skill & { nodeRelativePath: string | null }>> {
  // Read through the injected backend. backend.readSkill returns the
  // effective content (it resolves the package primary SKILL.md vs the legacy
  // column internally), and the node path resolves via backend.getNodeForSkill.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const skill = await ctx.backend.readSkill(args.skill_id);
    if (!skill) {
      return {
        ok: false,
        error: { code: "not_found", message: `Skill ${args.skill_id} not found` },
      };
    }
    const node = await ctx.backend.getNodeForSkill(skill.id);
    return { ok: true, data: { ...skill, nodeRelativePath: node?.relativePath ?? null } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Writes (M8.7 path-first)
// -----------------------------------------------------------------------------

export interface WriteSkillArgs {
  /** Workspace-relative path. Missing nodes auto-create. */
  node_path: string;
  name: string;
  description: string | null;
  /** Full SKILL.md body (frontmatter + markdown). Claude-authored via skill-creator, or human-authored. */
  content: string;
  source?: SkillSource;
  github_url?: string | null;
  tags?: string[];
}

export async function writeSkillHandler(
  ctx: ToolContext,
  args: WriteSkillArgs,
): Promise<ToolResult<Skill>> {
  if (!ctx.workspaceId) {
    return {
      ok: false,
      error: {
        code: "invalid_args",
        message: "ctx.workspaceId is required for path-based writes",
      },
    };
  }
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Demo-guard → ensureNodeForPath → dedup → writeSkill (inserts + attaches).
  try {
    if (await ctx.backend.isDemoWorkspace(ctx.workspaceId)) {
      return { ok: false, error: { code: "permission_denied", message: DEMO_READONLY_MESSAGE } };
    }
    const node = await ctx.backend.ensureNodeForPath(ctx.workspaceId, args.node_path);

    const candidate = args.name.trim();
    const dedup = await ctx.backend.checkContentDedup({
      workspaceId: node.workspace_id,
      kind: "skill",
      candidate,
      maxSimilar: 0,
    });
    if (dedup.duplicate) {
      return {
        ok: false,
        error: {
          code: "duplicate",
          message: `A skill with this name already exists in this workspace: "${dedup.duplicate.title}". Use update_skill or pick a different name.`,
          detail: { existing_id: dedup.duplicate.id, existing_name: dedup.duplicate.title },
        },
      };
    }

    const skill = await ctx.backend.writeSkill({
      workspaceId: node.workspace_id,
      nodeId: node.id,
      name: candidate,
      description: args.description,
      content: args.content,
      source: args.source,
      githubUrl: args.github_url ?? null,
      tags: args.tags,
    });
    return { ok: true, data: skill };
  } catch (err) {
    // The DB slug-unique index is the race safety net behind the dedup pre-check.
    if (isSkillSlugUniqueViolation(err as { code?: string; message?: string })) {
      return {
        ok: false,
        error: {
          code: "duplicate",
          message: `A skill with this name already exists in this workspace. Use update_skill or pick a different name.`,
        },
      };
    }
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface UpdateSkillArgs {
  skill_id: string;
  expected_version_id?: string;
  patch: Partial<{
    name: string;
    description: string | null;
    content: string;
    source: SkillSource;
    github_url: string | null;
    tags: string[];
  }>;
  /** Surgical delta applied server-side to the current body — avoids resending the whole content. */
  content_edit?: ContentEdit;
  /** Optional — move the skill's node_skills attachment to a different path (materialises on demand). */
  move_to_path?: string;
}

export async function updateSkillHandler(
  ctx: ToolContext,
  args: UpdateSkillArgs,
): Promise<ToolResult<Skill | { conflict: true; current_version_id: string }>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  // Conflict + rename-dedup + move policy here; backend.updateSkill bumps the
  // version (optimistic guard), patches only supplied fields (incl. the github_ref
  // staleness clock), and re-homes node_skills when nodeId is given.
  try {
    const current = await ctx.backend.readSkill(args.skill_id);
    if (!current) {
      return {
        ok: false,
        error: { code: "not_found", message: `Skill ${args.skill_id} not found` },
      };
    }

    if (args.expected_version_id && current.versionId !== args.expected_version_id) {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "Skill has been modified since you last read it.",
          detail: { current_version_id: current.versionId },
        },
      };
    }

    if (args.patch.name !== undefined) {
      const candidate = args.patch.name.trim();
      const dedup = await ctx.backend.checkContentDedup({
        workspaceId: current.workspaceId,
        kind: "skill",
        candidate,
        excludeId: args.skill_id,
        maxSimilar: 0,
      });
      if (dedup.duplicate) {
        return {
          ok: false,
          error: {
            code: "duplicate",
            message: `Another skill in this workspace already uses this name: "${dedup.duplicate.title}". Pick a different name.`,
            detail: { existing_id: dedup.duplicate.id, existing_name: dedup.duplicate.title },
          },
        };
      }
    }

    let targetNodeId: string | undefined;
    if (args.move_to_path) {
      const target = await ctx.backend.ensureNodeForPath(current.workspaceId, args.move_to_path);
      targetNodeId = target.id;
    }

    const resolved = resolveEditedContent({
      currentContent: current.content,
      content: args.patch.content,
      contentEdit: args.content_edit,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const updated = await ctx.backend.updateSkill({
      id: args.skill_id,
      name: args.patch.name !== undefined ? args.patch.name.trim() : undefined,
      content: resolved.content,
      description: args.patch.description,
      source: args.patch.source,
      githubUrl: args.patch.github_url,
      tags: args.patch.tags,
      nodeId: targetNodeId,
    });
    return { ok: true, data: updated };
  } catch (err) {
    if (isSkillSlugUniqueViolation(err as { code?: string; message?: string })) {
      return {
        ok: false,
        error: {
          code: "duplicate",
          message: `Another skill in this workspace already uses this name. Pick a different name.`,
        },
      };
    }
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// Delete + restore (DX-1)
// -----------------------------------------------------------------------------

export interface DeleteSkillArgs {
  skill_id: string;
  hard?: boolean;
  expected_version_id?: string;
}

export interface DeleteSkillResult {
  id: string;
  workspaceId: string;
  hard: boolean;
}

export async function deleteSkillHandler(
  ctx: ToolContext,
  args: DeleteSkillArgs,
): Promise<ToolResult<DeleteSkillResult>> {
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const res = await ctx.backend.deleteSkill({
      id: args.skill_id,
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
          message: "Skill has been modified since you last read it.",
          detail: { current_version_id: res.currentVersionId },
        },
      };
    }
    return { ok: true, data: { id: res.id, workspaceId: res.workspaceId, hard: !!args.hard } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

export interface RestoreSkillArgs {
  skill_id: string;
}

export async function restoreSkillHandler(
  ctx: ToolContext,
  args: RestoreSkillArgs,
): Promise<ToolResult<{ id: string; workspaceId: string }>> {
  // Restore owned by the backend (cloud: restore_skill_rpc; local: status flip).
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const res = await ctx.backend.restoreSkill(args.skill_id);
    if (res.status === "rejected") return { ok: false, error: mapRpcError(res.reason) };
    return { ok: true, data: { id: res.id, workspaceId: res.workspaceId } };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}
