// SPDX-License-Identifier: Apache-2.0
// The pure workspace-overview contracts + grouping helper, split out of
// tree.ts so the core backends can import them without dragging the
// ToolContext/database-typed handler layer into this shared export set.
// tree.ts re-exports these — every existing import path keeps working.

import { semanticTagsOrInfer } from "../retrieval/semantic-tags.js";

/** A single non-empty node in the workspace's router index. */
export interface WorkspaceOverviewNode {
  node_id: string;
  relative_path: string;
  memories: { id: string; title: string; semantic_tags?: string[] }[];
  rules: {
    id: string;
    name: string;
    scope_type: string;
    priority: string;
    semantic_tags?: string[];
  }[];
  skills: { id: string; name: string; source: string; semantic_tags?: string[] }[];
}

// ── Pure overview grouping (shared so every backend produces identical shapes) ──
// Flat rows in → grouped WorkspaceOverviewNode[] out. semantic_tags inferred when absent;
// empty/orphan/excluded nodes dropped; sorted by path. The single source of truth for the
// workspace_overview shape: Pathrule Cloud's Project backend and LocalBackend (SQLite) both
// feed THIS — so cloud and local can't diverge. Lives in shared (not the @pathrule/core
// barrel) so importing it never drags better-sqlite3 into the browser bundles.
export interface OverviewMemoryRow {
  id: string;
  title: string;
  nodeId: string;
  semanticTags?: readonly string[] | null;
}
export interface OverviewRuleRow {
  nodeId: string;
  id: string;
  name: string;
  content?: string | null;
  scopeType: string;
  priority: string;
  semanticTags?: readonly string[] | null;
}
export interface OverviewSkillRow {
  nodeId: string;
  id: string;
  name: string;
  description?: string | null;
  source: string;
  tags?: string[] | null;
  semanticTags?: readonly string[] | null;
}

export function buildWorkspaceOverview(input: {
  nodes: Array<{ id: string; relativePath: string }>;
  memories: OverviewMemoryRow[];
  rules: OverviewRuleRow[];
  skills: OverviewSkillRow[];
  excludeNodeId?: string;
}): WorkspaceOverviewNode[] {
  type Bucket = {
    memories: WorkspaceOverviewNode["memories"];
    rules: WorkspaceOverviewNode["rules"];
    skills: WorkspaceOverviewNode["skills"];
  };
  const pathByNode = new Map<string, string>();
  for (const n of input.nodes) pathByNode.set(n.id, n.relativePath);
  const bucketByNode = new Map<string, Bucket>();
  const bucket = (nodeId: string): Bucket => {
    let b = bucketByNode.get(nodeId);
    if (!b) {
      b = { memories: [], rules: [], skills: [] };
      bucketByNode.set(nodeId, b);
    }
    return b;
  };

  for (const m of input.memories) {
    bucket(m.nodeId).memories.push({
      id: m.id,
      title: m.title,
      semantic_tags: semanticTagsOrInfer(m.semanticTags, {
        text: m.title,
        path: pathByNode.get(m.nodeId),
      }),
    });
  }
  for (const r of input.rules) {
    bucket(r.nodeId).rules.push({
      id: r.id,
      name: r.name,
      scope_type: r.scopeType,
      priority: r.priority,
      semantic_tags: semanticTagsOrInfer(r.semanticTags, {
        text: `${r.name} ${r.content ?? ""}`,
        path: pathByNode.get(r.nodeId),
      }),
    });
  }
  for (const s of input.skills) {
    bucket(s.nodeId).skills.push({
      id: s.id,
      name: s.name,
      source: s.source,
      semantic_tags: semanticTagsOrInfer(s.semanticTags, {
        text: `${s.name} ${typeof s.description === "string" ? s.description : ""}`,
        path: pathByNode.get(s.nodeId),
        existingTags: s.tags,
      }),
    });
  }

  const out: WorkspaceOverviewNode[] = [];
  for (const [nodeId, b] of bucketByNode.entries()) {
    if (input.excludeNodeId && nodeId === input.excludeNodeId) continue;
    const path = pathByNode.get(nodeId);
    if (!path) continue; // orphan content — skip
    if (b.memories.length === 0 && b.rules.length === 0 && b.skills.length === 0) continue;
    out.push({
      node_id: nodeId,
      relative_path: path,
      memories: b.memories,
      rules: b.rules,
      skills: b.skills,
    });
  }
  out.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return out;
}
