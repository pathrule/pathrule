// SPDX-License-Identifier: Apache-2.0
// Create / delete / save-selection flows (design spec §4.6: two QuickInputs
// max — title/name, then the content opens as a tab template).

import * as nodePath from "node:path";

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import type { BoundFolder } from "../binding/types.js";
import type { PathruleFileSystem } from "../fs/provider.js";
import { contentUriParts, type ContentKind, type ContentRef } from "../fs/uri.js";
import { activeFileTarget } from "../tree/active-file.js";
import {
  allLeaves,
  normalizePath,
  type ContentLeaf,
  type KnowledgeTree,
  type PathNode,
} from "../tree/model.js";
import { kindIcon, themeIcon } from "../ui/theme.js";
import { strings } from "../ui/strings.js";

export interface ContentCommandDeps {
  manager: BindingManager;
  fs: PathruleFileSystem;
  /** Current tree (for default target paths) — may be null before first load. */
  currentTreeNodeForActiveFile(): string | null;
  knowledgeTree(): KnowledgeTree | null;
  refresh(): Promise<void>;
}

/** Tree rows pass a PathNode; the built-in Explorer's context menu passes a Uri. */
function targetPathFrom(deps: ContentCommandDeps, el?: PathNode | vscode.Uri): string | null {
  if (!el) return null;
  if (el instanceof vscode.Uri) {
    const binding = bound(deps);
    if (!binding) return null;
    const rel = nodePath.relative(binding.localRootPath, el.fsPath);
    if (rel === "" || rel === ".") return "/";
    if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
    return `/${rel.split(nodePath.sep).join("/")}`;
  }
  return el.path || "/";
}

export function registerContentCommands(
  context: vscode.ExtensionContext,
  deps: ContentCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.newMemory", (el?: PathNode | vscode.Uri) =>
      createContent("memory", deps, targetPathFrom(deps, el)),
    ),
    vscode.commands.registerCommand("pathrule.newRule", (el?: PathNode | vscode.Uri) =>
      createContent("rule", deps, targetPathFrom(deps, el)),
    ),
    vscode.commands.registerCommand("pathrule.newSkill", (el?: PathNode | vscode.Uri) =>
      createContent("skill", deps, targetPathFrom(deps, el)),
    ),
    vscode.commands.registerCommand("pathrule.saveSelectionAsMemory", () =>
      saveSelectionAsMemory(deps),
    ),
    vscode.commands.registerCommand("pathrule.browseKnowledge", (el?: PathNode | vscode.Uri) =>
      browseKnowledge(deps, el),
    ),
    vscode.commands.registerCommand("pathrule.openContent", (ref: ContentRef, label: string) =>
      openContent(ref, label),
    ),
    // Tree context commands receive (focused, selected[]) — multi-select aware.
    vscode.commands.registerCommand(
      "pathrule.deleteContent",
      (el?: ContentLeaf, selected?: KnowledgeElementLike[]) =>
        deleteContent(deps, leafTargets(el, selected)),
    ),
    vscode.commands.registerCommand(
      "pathrule.moveContent",
      (el?: ContentLeaf, selected?: KnowledgeElementLike[]) =>
        moveContent(deps, leafTargets(el, selected)),
    ),
    vscode.commands.registerCommand("pathrule.renameContent", (el?: ContentLeaf) =>
      renameContent(deps, el),
    ),
    vscode.commands.registerCommand("pathrule.contentInfo", (el?: ContentLeaf) =>
      contentInfo(deps, el),
    ),
    vscode.commands.registerCommand("pathrule.copyContentPrompt", (el?: ContentLeaf) =>
      copyContentPrompt(deps, el),
    ),
    vscode.commands.registerCommand("pathrule.searchKnowledge", () => searchKnowledge(deps)),
  );
}

type KnowledgeElementLike = ContentLeaf | { kind: string };

/** Multi-select resolution: the selection when it holds leaves, else the focused leaf. */
function leafTargets(el?: ContentLeaf, selected?: KnowledgeElementLike[]): ContentLeaf[] {
  const fromSelection = (selected ?? []).filter(
    (item): item is ContentLeaf =>
      item.kind === "memory" || item.kind === "rule" || item.kind === "skill",
  );
  if (fromSelection.length > 0) return fromSelection;
  return el ? [el] : [];
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the full record (overview carries titles only) for metadata surfaces. */
async function readFullRecord(binding: BoundFolder, el: ContentLeaf) {
  return el.kind === "memory"
    ? await binding.backend.readMemory(el.id)
    : el.kind === "rule"
      ? await binding.backend.readRule(el.id)
      : await binding.backend.readSkill(el.id);
}

/** Who/when metadata (owner review round 12). Identity shows only when it is
 *  human-readable (local mode usernames); raw cloud uuids stay hidden. */
async function contentInfo(deps: ContentCommandDeps, el?: ContentLeaf): Promise<void> {
  const binding = bound(deps);
  if (!binding || !el) return;
  const record = await readFullRecord(binding, el);
  if (!record) return;

  const when = (iso: string): string => new Date(iso).toLocaleString();
  const identity = (value: string | null | undefined): string | null =>
    value && !UUID_LIKE.test(value) ? value : null;

  const lines = [strings.info.path(el.nodePath || "/")];
  const createdBy = identity((record as { createdBy?: string | null }).createdBy);
  lines.push(
    createdBy
      ? strings.info.createdBy(when(record.createdAt), createdBy)
      : strings.info.created(when(record.createdAt)),
  );
  const r = record as { lastEditedAt?: string; lastEditedBy?: string | null };
  if (r.lastEditedAt && r.lastEditedAt !== record.createdAt) {
    const editedBy = identity(r.lastEditedBy);
    lines.push(
      editedBy
        ? strings.info.editedBy(when(r.lastEditedAt), editedBy)
        : strings.info.edited(when(r.lastEditedAt)),
    );
  }
  lines.push(strings.info.version(record.versionNumber));
  if ("source" in record && record.source) lines.push(strings.info.source(String(record.source)));

  const choice = await vscode.window.showInformationMessage(
    strings.info.title(el.kind, el.label),
    { modal: true, detail: lines.join("\n") },
    strings.info.open,
    strings.info.copyPrompt,
  );
  if (choice === strings.info.open) {
    await openContent({ workspaceId: binding.workspaceId, kind: el.kind, id: el.id }, el.label);
  } else if (choice === strings.info.copyPrompt) {
    await copyContentPrompt(deps, el);
  }
}

/** Agent-ready pointer prompt (owner review round 12): paste into any AI chat
 *  to aim the agent at this exact content through the Pathrule MCP tools. */
async function copyContentPrompt(deps: ContentCommandDeps, el?: ContentLeaf): Promise<void> {
  const binding = bound(deps);
  if (!binding || !el) return;
  await vscode.env.clipboard.writeText(
    strings.prompt.forContent(el.kind, el.label, el.nodePath || "/", el.id),
  );
  void vscode.window.showInformationMessage(strings.prompt.copied);
}

function bound(deps: ContentCommandDeps): BoundFolder | null {
  const binding = deps.manager.current();
  return binding !== null && binding.kind !== "unbound" ? binding : null;
}

async function openContent(ref: ContentRef, label: string): Promise<void> {
  const parts = contentUriParts(ref, label);
  const uri = vscode.Uri.from(parts);
  await vscode.window.showTextDocument(uri, { preview: true });
}

async function createContent(
  kind: ContentKind,
  deps: ContentCommandDeps,
  targetPath: string | null,
): Promise<void> {
  const binding = bound(deps);
  if (!binding) {
    await vscode.commands.executeCommand("pathrule.setUp");
    return;
  }
  const prompts = {
    memory: [strings.create.memoryTitlePrompt, strings.create.memoryTitlePlaceholder],
    rule: [strings.create.ruleNamePrompt, strings.create.ruleNamePlaceholder],
    skill: [strings.create.skillNamePrompt, strings.create.skillNamePlaceholder],
  }[kind];
  const title = await vscode.window.showInputBox({
    prompt: prompts[0],
    placeHolder: prompts[1],
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? prompts[0] : null),
  });
  if (!title) return;

  const path =
    targetPath ??
    deps.currentTreeNodeForActiveFile() ??
    (await vscode.window.showInputBox({
      prompt: strings.create.pickPathPrompt,
      value: "/",
      ignoreFocusOut: true,
    }));
  if (path === undefined) return;

  const ref = await createRecord(binding, kind, title.trim(), path || "/");
  await deps.refresh();
  await openContent(ref, title.trim());
}

async function createRecord(
  binding: BoundFolder,
  kind: ContentKind,
  title: string,
  path: string,
): Promise<ContentRef> {
  const node = await binding.backend.ensureNodeForPath(binding.workspaceId, path);
  const base = { workspaceId: binding.workspaceId, nodeId: node.id };
  switch (kind) {
    case "memory": {
      const m = await binding.backend.writeMemory({
        ...base,
        title,
        content: strings.create.memoryTemplate(title),
        source: "manual",
      });
      return { workspaceId: binding.workspaceId, kind, id: m.id };
    }
    case "rule": {
      const r = await binding.backend.writeRule({
        ...base,
        name: title,
        content: strings.create.ruleTemplate,
        scopeType: "folder",
      });
      return { workspaceId: binding.workspaceId, kind, id: r.id };
    }
    case "skill": {
      const s = await binding.backend.writeSkill({
        ...base,
        name: title,
        content: strings.create.skillTemplate(title),
        source: "manual",
      });
      return { workspaceId: binding.workspaceId, kind, id: s.id };
    }
  }
}

/**
 * The agent-eye view for a path (owner review round 8): everything scoped to
 * it PLUS what it inherits from ancestor paths — exactly what an AI session
 * there receives. QuickPick, separators per scope, pick → markdown tab.
 */
async function browseKnowledge(
  deps: ContentCommandDeps,
  el?: PathNode | vscode.Uri,
): Promise<void> {
  const binding = bound(deps);
  const tree = deps.knowledgeTree();
  if (!binding || !tree) return;
  const target = normalizePath(
    targetPathFrom(deps, el) ?? deps.currentTreeNodeForActiveFile() ?? "/",
  );

  // Walk target → root, collecting each scope's content (most specific first).
  const scopes: PathNode[] = [];
  for (let path = target; ; path = path.slice(0, path.lastIndexOf("/"))) {
    const node = tree.byPath.get(path);
    if (node && node.content.length > 0) scopes.push(node);
    if (path === "") break;
  }

  if (scopes.length === 0) {
    const add = await vscode.window.showInformationMessage(
      strings.browse.empty(target || "/"),
      strings.browse.addFirst,
    );
    if (add === strings.browse.addFirst) {
      await createContent("memory", deps, target || "/");
    }
    return;
  }

  type Item = vscode.QuickPickItem & { leaf?: ContentLeaf };
  const items: Item[] = scopes.flatMap((scope): Item[] => [
    {
      label:
        scope.path === target ? scope.path || "/" : strings.browse.inheritedFrom(scope.path || "/"),
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...scope.content.map(
      (leaf): Item => ({
        label: leaf.label,
        description: leaf.detail ?? undefined,
        iconPath: kindIcon(leaf.kind),
        leaf,
      }),
    ),
  ]);

  const picked = await vscode.window.showQuickPick(items, {
    title: strings.browse.title(target || "/"),
    placeHolder: strings.browse.placeholder,
    matchOnDescription: true,
  });
  if (!picked?.leaf) return;
  await openContent(
    { workspaceId: binding.workspaceId, kind: picked.leaf.kind, id: picked.leaf.id },
    picked.leaf.label,
  );
}

async function saveSelectionAsMemory(deps: ContentCommandDeps): Promise<void> {
  const binding = bound(deps);
  const editor = vscode.window.activeTextEditor;
  if (!binding || !editor) return;
  const selection = editor.document.getText(editor.selection).trim();
  const title = await vscode.window.showInputBox({
    prompt: strings.create.memoryTitlePrompt,
    value: strings.create.selectionDefaultTitle,
    ignoreFocusOut: true,
  });
  if (!title) return;
  // A selection's natural scope is the FILE itself — the most specific path
  // (owner review round 5); routing inherits it upward anyway.
  const rel = nodePath.relative(binding.localRootPath, editor.document.uri.fsPath);
  const path =
    rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel)
      ? `/${rel.split(nodePath.sep).join("/")}`
      : (activeFileTarget(editor.document.uri.fsPath, binding, null)?.relativePath ?? "/");
  const node = await binding.backend.ensureNodeForPath(binding.workspaceId, path || "/");
  const body = selection
    ? `${strings.create.memoryTemplate(title)}${"```"}\n${selection}\n${"```"}\n`
    : strings.create.memoryTemplate(title);
  const memory = await binding.backend.writeMemory({
    workspaceId: binding.workspaceId,
    nodeId: node.id,
    title: title.trim(),
    content: body,
    source: "manual",
  });
  await deps.refresh();
  await openContent({ workspaceId: binding.workspaceId, kind: "memory", id: memory.id }, title);
}

async function deleteContent(deps: ContentCommandDeps, targets: ContentLeaf[]): Promise<void> {
  const binding = bound(deps);
  if (!binding || targets.length === 0) return;
  const first = targets[0]!;
  const choice = await vscode.window.showWarningMessage(
    targets.length === 1
      ? strings.remove.confirm(first.kind, first.label)
      : strings.bulk.deleteConfirm(targets.length),
    { modal: true, detail: strings.remove.confirmDetail },
    strings.remove.confirmAction,
  );
  if (choice !== strings.remove.confirmAction) return;

  const deleted: ContentLeaf[] = [];
  for (const el of targets) {
    const input = { id: el.id };
    const result =
      el.kind === "memory"
        ? await binding.backend.deleteMemory(input)
        : el.kind === "rule"
          ? await binding.backend.deleteRule(input)
          : await binding.backend.deleteSkill(input);
    if (result.status === "deleted") deleted.push(el);
  }
  if (deleted.length === 0) return;
  await deps.refresh();

  const undo = await vscode.window.showInformationMessage(
    deleted.length === 1 ? strings.remove.undone(first.kind) : strings.bulk.deleted(deleted.length),
    strings.remove.undo,
  );
  if (undo === strings.remove.undo) {
    for (const el of deleted) {
      if (el.kind === "memory") await binding.backend.restoreMemory(el.id);
      else if (el.kind === "rule") await binding.backend.restoreRule(el.id);
      else await binding.backend.restoreSkill(el.id);
    }
    await deps.refresh();
  }
}

/** Move via path picker (owner round 17): known paths + free-form input; the
 *  target node materialises on demand. Multi-select moves in one pick. */
async function moveContent(deps: ContentCommandDeps, targets: ContentLeaf[]): Promise<void> {
  const binding = bound(deps);
  if (!binding || targets.length === 0) return;
  const tree = deps.knowledgeTree();

  const knownPaths = tree
    ? [...tree.byPath.keys()].sort((a, b) => a.localeCompare(b)).map((p) => p || "/")
    : ["/"];
  type PathItem = vscode.QuickPickItem & { custom?: boolean };
  const picked = await vscode.window.showQuickPick<PathItem>(
    [
      ...knownPaths.map((p): PathItem => ({ label: p, iconPath: themeIcon("pathFolder") })),
      { label: strings.move.customPath, custom: true, iconPath: themeIcon("add") },
    ],
    { title: strings.move.pickTitle(targets.length), ignoreFocusOut: true },
  );
  if (!picked) return;
  const targetPath = picked.custom
    ? await vscode.window.showInputBox({
        prompt: strings.move.customPrompt,
        value: "/",
        ignoreFocusOut: true,
      })
    : picked.label;
  if (!targetPath) return;

  const node = await binding.backend.ensureNodeForPath(
    binding.workspaceId,
    targetPath === "/" ? "/" : targetPath,
  );
  for (const el of targets) {
    if (el.kind === "memory") await binding.backend.updateMemory({ id: el.id, nodeId: node.id });
    else if (el.kind === "rule") await binding.backend.updateRule({ id: el.id, nodeId: node.id });
    else await binding.backend.updateSkill({ id: el.id, nodeId: node.id });
  }
  await deps.refresh();
  void vscode.window.showInformationMessage(strings.move.done(targets.length, targetPath));
}

async function renameContent(deps: ContentCommandDeps, el?: ContentLeaf): Promise<void> {
  const binding = bound(deps);
  if (!binding || !el) return;
  const next = await vscode.window.showInputBox({
    prompt: strings.rename.prompt(el.kind),
    value: el.label,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? strings.rename.prompt(el.kind) : null),
  });
  if (!next || next.trim() === el.label) return;
  const name = next.trim();
  if (el.kind === "memory") await binding.backend.updateMemory({ id: el.id, title: name });
  else if (el.kind === "rule") await binding.backend.updateRule({ id: el.id, name });
  else await binding.backend.updateSkill({ id: el.id, name });
  await deps.refresh();
}

/** Command-palette fuzzy search over every title in the workspace (round 17). */
async function searchKnowledge(deps: ContentCommandDeps): Promise<void> {
  const binding = bound(deps);
  const tree = deps.knowledgeTree();
  if (!binding) {
    await vscode.commands.executeCommand("pathrule.setUp");
    return;
  }
  const leaves = tree ? allLeaves(tree) : [];
  if (leaves.length === 0) {
    void vscode.window.showInformationMessage(strings.search.nothing);
    return;
  }
  type Item = vscode.QuickPickItem & { leaf: ContentLeaf };
  const picked = await vscode.window.showQuickPick<Item>(
    leaves.map(
      (leaf): Item => ({
        label: leaf.label,
        description: leaf.nodePath || "/",
        iconPath: kindIcon(leaf.kind),
        leaf,
      }),
    ),
    {
      title: strings.search.title,
      placeHolder: strings.search.placeholder,
      matchOnDescription: true,
    },
  );
  if (!picked) return;
  await openContent(
    { workspaceId: binding.workspaceId, kind: picked.leaf.kind, id: picked.leaf.id },
    picked.leaf.label,
  );
}
