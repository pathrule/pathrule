// SPDX-License-Identifier: Apache-2.0
// Knowledge tree = the KNOWLEDGE MAP (owner review round 6): only paths that
// carry memories/rules/skills render (intermediate segments materialised so
// the hierarchy reads like the repo). Creation lives in the built-in
// Explorer's Pathrule submenu + the editor; an empty map gets a designed
// welcome that points there. Folders sort before files (explorer parity);
// counts render as colored dot badges.

import { stat } from "node:fs/promises";
import * as nodePath from "node:path";

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import { kindColor, kindIcon, themeIcon } from "../ui/theme.js";
import { strings } from "../ui/strings.js";
import {
  buildKnowledgeTree,
  closestTreePath,
  groupContent,
  type ContentGroup,
  type ContentLeaf,
  type KnowledgeTree,
  type PathNode,
} from "./model.js";

export type KnowledgeElement = PathNode | ContentLeaf | ContentGroup;

/** Custom scheme so decorations never leak onto real files in other views. */
const NODE_SCHEME = "pathrule-node";

export class KnowledgeTreeProvider
  implements vscode.TreeDataProvider<KnowledgeElement>, vscode.FileDecorationProvider
{
  private readonly changed = new vscode.EventEmitter<KnowledgeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;

  private tree: KnowledgeTree | null = null;
  private readonly groupsByPath = new Map<string, ContentGroup[]>();
  /** isFile classification survives refreshes — paths rarely change class (fix #10). */
  private readonly isFileCache = new Map<string, boolean>();
  private loading = false;
  /** A refresh requested mid-flight reruns after the current one (fix #9). */
  private pendingRefresh = false;

  constructor(private readonly manager: BindingManager) {}

  current(): KnowledgeTree | null {
    return this.tree;
  }

  /** Deepest content-carrying node covering the path — reveal/status target. */
  closest(relativePath: string): PathNode | null {
    return this.tree ? closestTreePath(this.tree, relativePath) : null;
  }

  /** Re-render decorations (e.g. the explorerBadges setting flipped). */
  refreshDecorations(): void {
    this.decorationsChanged.fire(undefined);
  }

  async refresh(): Promise<void> {
    const binding = this.manager.current();
    this.groupsByPath.clear();
    if (binding === null || binding.kind === "unbound") {
      this.tree = null;
      this.isFileCache.clear();
      this.changed.fire(undefined);
      return;
    }
    if (this.loading) {
      this.pendingRefresh = true; // never drop a mid-flight request (fix #9)
      return;
    }
    this.loading = true;
    try {
      const overview = await binding.backend.workspaceOverview(binding.workspaceId);
      this.tree = buildKnowledgeTree(overview);
      await this.classifyFiles(binding.localRootPath);
    } finally {
      this.loading = false;
    }
    this.changed.fire(undefined);
    this.decorationsChanged.fire(undefined);
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      await this.refresh();
    }
  }

  /**
   * Count badges as REAL theme-aware color (FileDecorationProvider — the
   * native mechanism behind git's colored M/U letters; owner review round 7).
   * Badge = total items on the path, color = the dominant kind; the exact
   * per-kind breakdown lives one level down in the colored group rows.
   */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.tree) return undefined;
    let lookupPath: string | null = null;
    if (uri.scheme === NODE_SCHEME) {
      lookupPath = uri.path === "/" ? "" : uri.path;
    } else if (uri.scheme === "file") {
      // Knowledge badges on REAL files/folders in the Explorer (round 8) —
      // exact-path matches only (inheritance would badge everything).
      if (!vscode.workspace.getConfiguration("pathrule").get<boolean>("explorerBadges")) {
        return undefined;
      }
      const binding = this.manager.current();
      if (binding === null || binding.kind === "unbound") return undefined;
      const rel = nodePath.relative(binding.localRootPath, uri.fsPath);
      if (rel === "" || rel.startsWith("..") || nodePath.isAbsolute(rel)) return undefined;
      lookupPath = `/${rel.split(nodePath.sep).join("/")}`;
    }
    if (lookupPath === null) return undefined;
    const node = this.tree.byPath.get(lookupPath);
    if (!node) return undefined;
    const { memories, rules, skills } = node.counts;
    const total = memories + rules + skills;
    if (total === 0) return undefined;
    const dominant =
      rules > memories && rules >= skills
        ? "rule"
        : skills > memories && skills > rules
          ? "skill"
          : "memory";
    const decoration = new vscode.FileDecoration(
      total > 99 ? "99" : String(total),
      strings.counts.summary(memories, rules, skills),
      kindColor(dominant),
    );
    return decoration;
  }

  /** Leaf paths may be FILE nodes — stat only paths not seen before (fix #10). */
  private async classifyFiles(localRootPath: string): Promise<void> {
    if (!this.tree) return;
    await Promise.all(
      [...this.tree.byPath.values()].map(async (node) => {
        if (node.path === "" || node.children.length > 0) {
          node.isFile = false;
          return;
        }
        const cached = this.isFileCache.get(node.path);
        if (cached !== undefined) {
          node.isFile = cached;
          return;
        }
        try {
          node.isFile = (await stat(nodePath.join(localRootPath, node.path))).isFile();
        } catch {
          node.isFile = false;
        }
        this.isFileCache.set(node.path, node.isFile);
      }),
    );
  }

  getTreeItem(element: KnowledgeElement): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${element.nodePath}:${element.contentKind}`;
      item.description = String(element.items.length);
      item.iconPath = kindIcon(element.contentKind);
      item.contextValue = "pathruleGroup";
      item.accessibilityInformation = {
        label: `${element.label}, ${element.items.length} items`,
      };
      return item;
    }
    if (element.kind === "path") {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `path:${element.path}`;
      // Count badge + color arrive via provideFileDecoration (resourceUri).
      item.resourceUri = vscode.Uri.from({ scheme: NODE_SCHEME, path: element.path || "/" });
      item.iconPath = themeIcon(element.isFile ? "pathFile" : "pathFolder");
      item.contextValue = "pathrulePath";
      item.accessibilityInformation = {
        // Words, not dots, for screen readers.
        label: `Path ${element.path || "/"}, ${
          strings.counts.summary(
            element.counts.memories,
            element.counts.rules,
            element.counts.skills,
          ) || strings.counts.none
        }`,
      };
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${element.kind}:${element.id}`;
    item.description = element.detail ?? undefined;
    // Kind color lives on the GROUP row; leaves stay quiet gray documents
    // (owner review round 15: repeating the colored glyph per row is noise).
    item.iconPath = themeIcon("pathFile");
    item.contextValue = `pathrule${element.kind[0]?.toUpperCase()}${element.kind.slice(1)}`;
    item.accessibilityInformation = { label: `${element.kind} ${element.label}` };
    const binding = this.manager.current();
    if (binding !== null && binding.kind !== "unbound") {
      item.command = {
        command: "pathrule.openContent",
        title: "Open",
        arguments: [
          { workspaceId: binding.workspaceId, kind: element.kind, id: element.id },
          element.label,
        ],
      };
    }
    return item;
  }

  getChildren(element?: KnowledgeElement): KnowledgeElement[] {
    if (!this.tree) return [];
    if (element && element.kind === "group") return element.items;
    if (element && element.kind !== "path") return [];
    const parent = element ?? this.tree.root;
    // Explorer parity: folders first, then files; alphabetical within each.
    const folders = parent.children.filter((child) => !child.isFile);
    const files = parent.children.filter((child) => child.isFile);
    return [...folders, ...files, ...this.groupsFor(parent)];
  }

  private groupsFor(node: PathNode): ContentGroup[] {
    const cached = this.groupsByPath.get(node.path);
    if (cached) return cached;
    const groups = groupContent(node.content, node.path);
    this.groupsByPath.set(node.path, groups);
    return groups;
  }

  getParent(element: KnowledgeElement): KnowledgeElement | null {
    if (element.kind === "group") {
      const owner = this.tree?.byPath.get(element.nodePath);
      return owner && owner !== this.tree?.root ? owner : null;
    }
    if (element.kind !== "path") {
      const owner = this.tree?.byPath.get(element.nodePath);
      return owner
        ? (this.groupsFor(owner).find((g) => g.contentKind === element.kind) ?? null)
        : null;
    }
    return element.parent === this.tree?.root ? null : element.parent;
  }
}
