// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { getTreeHandler } from "@pathrule/core/tools/tree.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";
import { cacheGet, cachePut } from "../cache.js";
import { resolveContext } from "./helpers.js";
import { formatThrown, formatToolError } from "../errors.js";
import type { ToolDef } from "./types.js";

interface Args {
  workspace_id: string;
  root_path?: string;
  depth?: number;
}

/** "/a/b" | "a/b" | "" | "/" → "/", "/a/b". */
function normalizeRoot(p: string | undefined): string {
  if (!p) return "/";
  const s = p.startsWith("/") ? p : `/${p}`;
  return s === "" ? "/" : s.replace(/\/+$/, "") || "/";
}

/** Segment count of a relative path ("/" → 0, "/a" → 1, "/a/b" → 2). */
function segCount(relativePath: string): number {
  const norm = normalizeRoot(relativePath);
  return norm === "/" ? 0 : norm.split("/").filter(Boolean).length;
}

/**
 * Scope a flat TreeNode[] to a subtree (root_path) and/or a max depth below it.
 * Filtering happens after the seam fetch, so it needs no backend change and
 * works identically for Cloud + OSS local. The point is to shrink the payload
 * the AGENT receives on big monorepos, not the DB read.
 */
function scopeTree(nodes: TreeNode[], root: string, depth: number | undefined): TreeNode[] {
  const rootSegs = root === "/" ? 0 : segCount(root);
  return nodes.filter((n) => {
    const rp = normalizeRoot(n.relativePath);
    const inSubtree = root === "/" || rp === root || rp.startsWith(root + "/");
    if (!inSubtree) return false;
    if (depth === undefined) return true;
    return segCount(rp) - rootSegs <= depth;
  });
}

export const getTreeTool: ToolDef<Args> = {
  name: "pathrule_get_tree",
  title: "Get Workspace Tree",
  description:
    "Return the workspace node tree. Pass `root_path` to scope to a subtree and/or `depth` to limit how many levels below it are returned — do this on large monorepos instead of pulling every node. Omit both for the full tree. Use for navigation + planning; prefer pathrule_get_context when you just need the closest node for the caller's cwd.",
  inputSchema: {
    workspace_id: z.string().uuid().describe("Workspace UUID."),
    root_path: z
      .string()
      .optional()
      .describe("Scope to this subtree (workspace-relative, e.g. '/packages/app'). Omit for the whole tree."),
    depth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Max levels below root_path (0 = only the root node itself). Omit for unlimited depth."),
  },
  handler: async (args) => {
    try {
      const ctx = await resolveContext(args.workspace_id);
      const root = normalizeRoot(args.root_path);
      const scoped = root !== "/" || args.depth !== undefined;
      const key = {
        workspaceId: args.workspace_id,
        kind: "tree" as const,
        id: `all:${root}:${args.depth ?? "inf"}`,
      };
      const cached = await cacheGet<TreeNode[]>(key);
      if (cached) return { ok: true, nodes: cached, cache_hit: true, ...(scoped && { scoped: { root_path: root, depth: args.depth } }) };

      const result = await getTreeHandler(ctx, { workspace_id: args.workspace_id });
      if (!result.ok) return formatToolError(result.error);
      const nodes = scoped ? scopeTree(result.data, root, args.depth) : result.data;
      await cachePut(key, nodes);
      return { ok: true, nodes, ...(scoped && { scoped: { root_path: root, depth: args.depth } }) };
    } catch (e) {
      return formatThrown(e);
    }
  },
};
