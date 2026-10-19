// SPDX-License-Identifier: Apache-2.0
// Active-file → path sync: the extension's signature interaction. Debounced;
// honors the pathrule.revealActiveFile setting; updates the status bar with
// the closest path + its content counts.

import * as path from "node:path";

import type { BoundFolder, FolderBinding } from "../binding/types.js";
import { strings } from "../ui/strings.js";
import { normalizePath, type KnowledgeTree, type PathNode } from "./model.js";
import { closestTreePath } from "./model.js";

export interface ActiveFileTarget {
  relativePath: string;
  treeNode: PathNode | null;
  countsSummary: string | null;
}

/**
 * Pure compute: editor file path + binding + current tree → what to reveal
 * and what the status bar shows. Files outside the workspace root → null.
 */
export function activeFileTarget(
  fileFsPath: string | null,
  binding: FolderBinding | null,
  tree: KnowledgeTree | null,
): ActiveFileTarget | null {
  if (!fileFsPath || binding === null || binding.kind === "unbound") return null;
  const relative = workspaceRelative(binding, fileFsPath);
  if (relative === null) return null;
  const treeNode = tree ? closestTreePath(tree, relative) : null;
  const countsSummary = treeNode
    ? strings.counts.summary(
        treeNode.counts.memories,
        treeNode.counts.rules,
        treeNode.counts.skills,
      ) || null
    : null;
  return { relativePath: relative, treeNode, countsSummary };
}

function workspaceRelative(binding: BoundFolder, fileFsPath: string): string | null {
  const rel = path.relative(binding.localRootPath, fileFsPath);
  if (rel === "" || rel === ".") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Reveal targets the file's FOLDER — knowledge is path-scoped.
  const dir = path.dirname(rel);
  return normalizePath(dir === "." ? "" : dir.split(path.sep).join("/"));
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
