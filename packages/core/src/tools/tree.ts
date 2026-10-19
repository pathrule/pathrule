// SPDX-License-Identifier: Apache-2.0
//
// Tree + context handlers (Phase 5).
//
// getContextHandler is the hot path: called by Claude on nearly every prompt
// to figure out "what does Pathrule know about this folder?". Returns a
// compact index (ids + headline fields) so Claude can decide what to read_*
// next without a second lookup.

import type { ToolContext, ToolResult } from "./types.js";
import { mapStoreError } from "./types.js";
import type { NodeType, TreeNode } from "@pathrule/protocol/node-types.js";
import { isArchivedKnowledgePath } from "@pathrule/protocol/knowledge-archive.js";
import type { InvocationSkill } from "../index.js";
import {
  extractPatternImportMarkers,
  extractSkillInvocationMarkers,
  normalizeSkillInvocationName,
} from "@pathrule/protocol/skill-invocation.js";
import { semanticTagsOrInfer } from "../retrieval/semantic-tags.js";

// -----------------------------------------------------------------------------
// get_tree
// -----------------------------------------------------------------------------

export interface GetTreeArgs {
  workspace_id: string;
}

export async function getTreeHandler(
  ctx: ToolContext,
  args: GetTreeArgs,
): Promise<ToolResult<TreeNode[]>> {
  // The tree read is owned by the backend (cloud: nodes select ordered by
  // order_index; local: SQLite). Behaviour-neutral; the TreeNode shape is identical.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    return { ok: true, data: await ctx.backend.getTree(args.workspace_id) };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// get_node
// -----------------------------------------------------------------------------

export interface GetNodeArgs {
  node_id: string;
}

export interface NodeDetail {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  type: NodeType;
  relative_path: string;
  memory_ids: string[];
  rule_ids: string[];
  skill_ids: string[];
}

export async function getNodeHandler(
  ctx: ToolContext,
  args: GetNodeArgs,
): Promise<ToolResult<NodeDetail>> {
  // Node + attached ids owned by the backend (getNodeDetail). The handler
  // maps the camelCase record to the snake_case get_node output contract.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const d = await ctx.backend.getNodeDetail(args.node_id);
    if (!d) {
      return { ok: false, error: { code: "not_found", message: `Node ${args.node_id} not found` } };
    }
    return {
      ok: true,
      data: {
        id: d.id,
        workspace_id: d.workspaceId,
        parent_id: d.parentId,
        name: d.name,
        type: d.type as NodeType,
        relative_path: d.relativePath,
        memory_ids: d.memoryIds,
        rule_ids: d.ruleIds,
        skill_ids: d.skillIds,
      },
    };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

// -----------------------------------------------------------------------------
// get_context — the hot path
// -----------------------------------------------------------------------------

export interface GetContextArgs {
  /** Resolved by the MCP wrapper from cwd. */
  workspace_id: string;
  /** Already-narrowed to a node row's relative_path. Empty string = workspace root. */
  relative_path: string;
  /** Raw user prompt, used only to resolve explicit ::skill-name markers. */
  user_intent?: string;
}

// The pure overview contracts + grouping helper moved to ./overview.ts
// (OSS-importable, no ToolContext typing). Re-exported verbatim so every
// existing import path keeps working.
import type { WorkspaceOverviewNode } from "./overview.js";

export { buildWorkspaceOverview } from "./overview.js";
export type {
  WorkspaceOverviewNode,
  OverviewMemoryRow,
  OverviewRuleRow,
  OverviewSkillRow,
} from "./overview.js";

export interface ContextBundle {
  /**
   * The workspace-relative path that the caller's cwd resolves to — REGARDLESS
   * of whether a node exists there yet. Claude uses this as the `node_path`
   * argument for path-first writes (write_memory, write_rule, write_skill) so
   * nodes auto-materialise on the first write.
   */
  resolved_workspace_path: string;
  node: { id: string; name: string; relative_path: string } | null;
  memories: { id: string; title: string; preview: string; semantic_tags?: string[] }[];
  rules: {
    id: string;
    name: string;
    scope_type: string;
    priority: string;
    semantic_tags?: string[];
  }[];
  skills: {
    id: string;
    name: string;
    description: string | null;
    source: string;
    semantic_tags?: string[];
  }[];
  /**
   * llms.txt-style index of EVERY other non-empty node in the same workspace.
   * Claude sees this on every get_context call so it can write cross-references
   * ("See also /apps/mobile") naturally and the user's MainMemory.md view
   * becomes a real router. Empty when the current node is the only one with content.
   */
  workspace_overview: WorkspaceOverviewNode[];
  invoked_skills?: InvokedSkillContext[];
  missing_invoked_skills?: MissingInvokedSkill[];
  /** `::pathrule:package:<slug>` import directives found in the prompt. */
  pattern_imports?: { slug: string; raw: string }[];
}

export interface InvokedSkillContext {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  githubUrl: string | null;
  nodeRelativePath: string | null;
}

export interface MissingInvokedSkill {
  name: string;
  reason: "not_found" | "duplicate";
}

export interface GetWorkspaceOverviewArgs {
  workspace_id: string;
  /** Skip this node in the result (the caller usually excludes the "current" one). */
  exclude_node_id?: string;
}

/**
 * Returns every node in the workspace that has at least one memory / rule /
 * skill attached, with the titles + names inline. Cheap: 4 parallel selects,
 * grouped client-side. The result is deliberately compact (no content bodies)
 * so Claude can scan the whole workspace structure on every get_context call,
 * and the renderer can show a "See elsewhere" panel on the MainMemory view.
 */
export async function getWorkspaceOverviewHandler(
  ctx: ToolContext,
  args: GetWorkspaceOverviewArgs,
): Promise<ToolResult<WorkspaceOverviewNode[]>> {
  // Owned by the backend's workspaceOverview (cloud: 4 selects; local: SQLite),
  // both feeding buildWorkspaceOverview so the shape is identical across editions.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    const data = await ctx.backend.workspaceOverview(args.workspace_id, args.exclude_node_id);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}

function firstSentencePreview(md: string, max = 160): string {
  const stripped = md
    .replace(/`[^`]*`/g, "")
    .replace(/#+\s*/g, "")
    .replace(/[*_~]+/g, "")
    .trim();
  const dot = stripped.indexOf(".");
  const slice = dot > 0 && dot < max ? stripped.slice(0, dot + 1) : stripped.slice(0, max);
  return slice.length < stripped.length ? `${slice}…` : slice;
}

/**
 * Pure ::skill-name matcher. The skill set is fetched by the backend
 * (`listSkillsForInvocation`, effective content already resolved); this just extracts the
 * markers from the prompt and matches by normalised name — single match → invoked, none →
 * not_found, multiple → duplicate.
 */
function matchInvokedSkills(
  skills: InvocationSkill[],
  userIntent: string | undefined,
): {
  invokedSkills: InvokedSkillContext[];
  missingInvokedSkills: MissingInvokedSkill[];
} {
  const markers = extractSkillInvocationMarkers(userIntent ?? "");
  if (markers.length === 0) {
    return { invokedSkills: [], missingInvokedSkills: [] };
  }

  const byName = new Map<string, InvocationSkill[]>();
  for (const skill of skills) {
    if (!skill.name) continue;
    const key = normalizeSkillInvocationName(skill.name);
    byName.set(key, [...(byName.get(key) ?? []), skill]);
  }

  const invokedSkills: InvokedSkillContext[] = [];
  const missingInvokedSkills: MissingInvokedSkill[] = [];

  for (const marker of markers) {
    const matches = byName.get(marker.name) ?? [];
    if (matches.length === 0) {
      missingInvokedSkills.push({ name: marker.name, reason: "not_found" });
      continue;
    }
    if (matches.length > 1) {
      missingInvokedSkills.push({ name: marker.name, reason: "duplicate" });
      continue;
    }
    const skill = matches[0]!;
    invokedSkills.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: skill.source,
      githubUrl: skill.githubUrl,
      nodeRelativePath: null,
    });
  }

  return { invokedSkills, missingInvokedSkills };
}

/**
 * An archive node's knowledge is history (`knowledge-archive.ts`): the context overview names it only
 * to a caller asking about a path inside an archive. get_tree and the reads by id still show it.
 */
function withoutArchiveNodes(
  overview: WorkspaceOverviewNode[],
  relativePath: string,
): WorkspaceOverviewNode[] {
  if (isArchivedKnowledgePath(relativePath)) return overview;
  return overview.filter((node) => !isArchivedKnowledgePath(node.relative_path));
}

export async function getContextHandler(
  ctx: ToolContext,
  args: GetContextArgs,
): Promise<ToolResult<ContextBundle>> {
  // The whole bundle reads through ctx.backend now (node-by-path, node
  // content, workspace overview, skill-invocation set). The presentation shaping (preview,
  // semantic_tags inference, ::skill matching) stays here; the backend owns every data op.
  if (!ctx.backend) {
    return { ok: false, error: { code: "upstream_error", message: "No backend configured." } };
  }
  try {
    // Only hit the skill set when the prompt actually carries ::skill markers (preserves
    // the original short-circuit — no marker, no skills query).
    const markers = extractSkillInvocationMarkers(args.user_intent ?? "");
    const invocationSkills =
      markers.length > 0 ? await ctx.backend.listSkillsForInvocation(args.workspace_id) : [];
    const skillInvocation = matchInvokedSkills(invocationSkills, args.user_intent);
    const invokedSkills =
      skillInvocation.invokedSkills.length > 0 ? skillInvocation.invokedSkills : undefined;
    const missingInvokedSkills =
      skillInvocation.missingInvokedSkills.length > 0
        ? skillInvocation.missingInvokedSkills
        : undefined;

    // ::pathrule:package:<slug> import directives (separate from skills;
    // the reserved namespace guarantees they never reach skill matching).
    const patternMarkers = extractPatternImportMarkers(args.user_intent ?? "");
    const patternImports =
      patternMarkers.length > 0
        ? patternMarkers.map((m) => ({ slug: m.slug, raw: m.raw }))
        : undefined;

    // 1. Find the node at this exact path.
    const node = await ctx.backend.findNodeByPath(args.workspace_id, args.relative_path);

    if (!node) {
      // No node here — still return the overview so Claude sees what exists nearby;
      // resolved_workspace_path tells it exactly where a write would land.
      const overview = await ctx.backend.workspaceOverview(args.workspace_id);
      return {
        ok: true,
        data: {
          resolved_workspace_path: args.relative_path || "/",
          node: null,
          memories: [],
          rules: [],
          skills: [],
          workspace_overview: withoutArchiveNodes(overview, args.relative_path),
          invoked_skills: invokedSkills,
          missing_invoked_skills: missingInvokedSkills,
          pattern_imports: patternImports,
        },
      };
    }

    const [content, overview] = await Promise.all([
      ctx.backend.getNodeContent(node.id),
      ctx.backend.workspaceOverview(args.workspace_id, node.id),
    ]);

    const memories = content.memories.map((m) => ({
      id: m.id,
      title: m.title,
      preview: firstSentencePreview(m.content),
      semantic_tags: semanticTagsOrInfer(m.semanticTags, {
        text: `${m.title} ${m.content.slice(0, 1000)}`,
        path: node.relativePath,
      }),
    }));
    const rules: ContextBundle["rules"] = content.rules.map((r) => ({
      id: r.id,
      name: r.name,
      scope_type: r.scopeType,
      priority: r.priority,
      semantic_tags: semanticTagsOrInfer(r.semanticTags, {
        text: `${r.name} ${r.content}`,
        path: node.relativePath,
      }),
    }));
    const skills: ContextBundle["skills"] = content.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      semantic_tags: semanticTagsOrInfer(s.semanticTags, {
        text: `${s.name} ${s.description ?? ""}`,
        path: node.relativePath,
        existingTags: s.tags,
      }),
    }));

    return {
      ok: true,
      data: {
        resolved_workspace_path: args.relative_path || node.relativePath,
        node: { id: node.id, name: node.name, relative_path: node.relativePath },
        memories,
        rules,
        skills,
        workspace_overview: withoutArchiveNodes(overview, args.relative_path),
        invoked_skills: invokedSkills,
        missing_invoked_skills: missingInvokedSkills,
        pattern_imports: patternImports,
      },
    };
  } catch (err) {
    return { ok: false, error: mapStoreError(err as { code?: string; message: string }) };
  }
}
