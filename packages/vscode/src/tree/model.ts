// SPDX-License-Identifier: Apache-2.0
// Pure knowledge-tree model built from workspaceOverview() — the sparse tree
// of paths that actually carry content, with intermediate path segments
// materialised so the hierarchy reads like the repo. vscode-free for tests.

import type { WorkspaceOverviewNode } from "@pathrule/core/tools/overview.js";

export interface ContentLeaf {
  kind: "memory" | "rule" | "skill";
  id: string;
  label: string;
  /** Leading-slash path of the owning workspace path ("" = root). */
  nodePath: string;
  /** Detail shown dimmed next to the label (rule priority, skill source). */
  detail: string | null;
}

export interface PathNode {
  kind: "path";
  /** Leading-slash relative path; "" for the workspace root. */
  path: string;
  /** Last segment; "/" for the root. */
  name: string;
  counts: { memories: number; rules: number; skills: number };
  children: PathNode[];
  content: ContentLeaf[];
  parent: PathNode | null;
  /** True when the path is a FILE node (rendered only while knowledge is attached). */
  isFile?: boolean;
}

export interface KnowledgeTree {
  root: PathNode;
  byPath: Map<string, PathNode>;
}

/**
 * A path's content grouped by kind ("Memories", "Rules", "Skills"). Applied
 * at EVERY level — content piles grow, structure must stay scannable (owner
 * revisions 2026-06-07). `nodePath` keys group identity per path.
 */
export interface ContentGroup {
  kind: "group";
  contentKind: ContentLeaf["kind"];
  label: string;
  nodePath: string;
  items: ContentLeaf[];
}

const GROUP_LABELS: Record<ContentLeaf["kind"], string> = {
  memory: "Memories",
  rule: "Rules",
  skill: "Skills",
};

export function groupContent(content: ContentLeaf[], nodePath: string): ContentGroup[] {
  const order: ContentLeaf["kind"][] = ["memory", "rule", "skill"];
  return order
    .map((kind): ContentGroup => {
      const items = content.filter((leaf) => leaf.kind === kind);
      return { kind: "group", contentKind: kind, label: GROUP_LABELS[kind], nodePath, items };
    })
    .filter((group) => group.items.length > 0);
}

export function buildKnowledgeTree(overview: WorkspaceOverviewNode[]): KnowledgeTree {
  const root: PathNode = {
    kind: "path",
    path: "",
    name: "/",
    counts: { memories: 0, rules: 0, skills: 0 },
    children: [],
    content: [],
    parent: null,
  };
  const byPath = new Map<string, PathNode>([["", root]]);

  const ensure = (path: string): PathNode => {
    const normalized = normalizePath(path);
    const existing = byPath.get(normalized);
    if (existing) return existing;
    const parentPath = normalized.slice(0, normalized.lastIndexOf("/"));
    const parent = ensure(parentPath);
    const node: PathNode = {
      kind: "path",
      path: normalized,
      name: normalized.slice(normalized.lastIndexOf("/") + 1),
      counts: { memories: 0, rules: 0, skills: 0 },
      children: [],
      content: [],
      parent,
    };
    parent.children.push(node);
    byPath.set(normalized, node);
    return node;
  };

  for (const entry of overview) {
    const node = ensure(entry.relative_path);
    node.counts = {
      memories: entry.memories.length,
      rules: entry.rules.length,
      skills: entry.skills.length,
    };
    node.content = [
      ...entry.memories.map(
        (m): ContentLeaf => ({
          kind: "memory",
          id: m.id,
          label: m.title,
          nodePath: node.path,
          detail: null,
        }),
      ),
      ...entry.rules.map(
        (r): ContentLeaf => ({
          kind: "rule",
          id: r.id,
          label: r.name,
          nodePath: node.path,
          detail: r.priority,
        }),
      ),
      ...entry.skills.map(
        (s): ContentLeaf => ({
          kind: "skill",
          id: s.id,
          label: s.name,
          nodePath: node.path,
          detail: s.source === "github_ref" ? "linked" : null,
        }),
      ),
    ];
  }

  sortTree(root);
  return { root, byPath };
}

/** Every content leaf in the tree, most-specific paths first (search surface). */
export function allLeaves(tree: KnowledgeTree): ContentLeaf[] {
  return [...tree.byPath.entries()]
    .sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .flatMap(([, node]) => node.content);
}

/** Deepest tree node whose path is the given path or an ancestor of it. */
export function closestTreePath(tree: KnowledgeTree, relativePath: string): PathNode {
  let path = normalizePath(relativePath);
  for (;;) {
    const hit = tree.byPath.get(path);
    if (hit) return hit;
    if (path === "") return tree.root;
    path = path.slice(0, path.lastIndexOf("/"));
  }
}

export function normalizePath(path: string): string {
  if (path === "" || path === "/") return "";
  const lead = path.startsWith("/") ? path : `/${path}`;
  return lead.endsWith("/") ? lead.slice(0, -1) : lead;
}

function sortTree(node: PathNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of node.children) sortTree(child);
}
