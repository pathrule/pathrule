// SPDX-License-Identifier: Apache-2.0
// Activation, for any composition of the extension (./extension.ts composes Pathrule Cloud; the
// tests compose local mode alone). Activation discipline (design skill rule 6): status
// bar placeholder paints first; folder/backend resolution + view population run async after first
// paint.

import * as vscode from "vscode";

import { BindingManager } from "./binding/manager.js";
import type { ExtensionCapabilities } from "./capabilities.js";
import { readFolderMode } from "./binding/folder-mode.js";
import { closeLocalBinding, localModeAvailable, openLocalBinding } from "./binding/local.js";
import { registerContentCommands } from "./content/commands.js";
import { registerConnectCommand } from "./integration/connect.js";
import { registerDoctorCommand } from "./integration/doctor.js";
import { registerMcpProvider } from "./integration/provider.js";
import { registerOnboardingCommands } from "./onboarding/commands.js";
import { registerPushToCloud } from "./onboarding/push-to-cloud.js";
import { registerQuickMenu } from "./ui/quick-menu.js";
import { PathruleFileSystem } from "./fs/provider.js";
import { applyContextKeys } from "./lib/context-keys.js";
import { activeFileTarget, debounce } from "./tree/active-file.js";
import { ActivityFeedProvider } from "./tree/activity-provider.js";
import { KnowledgeTreeProvider, type KnowledgeElement } from "./tree/knowledge-provider.js";
import { initThemeAssets } from "./ui/theme.js";
import { createStatusBar } from "./ui/status-bar.js";
import { displayPath } from "./ui/status-text.js";
import { scheduleUpdateChecks } from "./updates/check.js";
import { setCliSelfCommand } from "#cli/local/self-command.js";
import { installCliPlugins } from "#cli/plugin.js";

const REVEAL_DEBOUNCE_MS = 150;

export function activateExtension(
  context: vscode.ExtensionContext,
  capabilities: ExtensionCapabilities,
): void {
  // The composition's CLI plugins: Pathrule Cloud's hook extensions, which the CLI modules this
  // extension runs (sync, hook install) write beside the hook, and the account.
  installCliPlugins(capabilities.cliPlugins);
  // The CLI modules this extension runs (init, sync, the local binding) reach the stores through
  // the home's host, launched when none runs with the bundled CLI under Electron as Node, as the
  // MCP entry runs it.
  setCliSelfCommand({
    command: process.execPath,
    args: [vscode.Uri.joinPath(context.extensionUri, "dist", "cli", "dist", "index.js").fsPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  const { cloud } = capabilities;
  initThemeAssets(context.extensionUri);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  // Without an account in the build, no folder is served from the cloud and no session exists.
  const cloudAvailable = (): boolean => (cloud ? cloud.available(process.env) : false);
  const manager = new BindingManager(folder, {
    // The folder's edition: the one answer every Pathrule surface uses.
    resolveMode: async (f) =>
      readFolderMode(f, process.env, {
        cloudAvailable: cloudAvailable(),
        localAvailable: await localModeAvailable(),
      }),
    openCloud: async (f) => (cloud ? cloud.resolveBinding(f, process.env) : null),
    cloudFailure: async (f) =>
      cloud?.bindingFailure ? cloud.bindingFailure(f, process.env) : "cloud-error",
    openLocal: (match) => openLocalBinding(match),
    cloudAvailable: async () => cloudAvailable(),
    hasSession: async () => (cloud ? cloud.hasSession(process.env) : false),
    localAvailable: () => localModeAvailable(),
    // One-click connect: when signed in on Desktop/CLI but this surface has no
    // (or a blocked) slot, offer the existing account instead of "Set up".
    adoptableAccount: async () => (cloud ? cloud.adoptableAccount(process.env) : null),
  });

  const statusBar = createStatusBar(manager, context.subscriptions);

  const knowledge = new KnowledgeTreeProvider(manager);
  const knowledgeView = vscode.window.createTreeView("pathrule.knowledgeTree", {
    treeDataProvider: knowledge,
    showCollapseAll: true,
    // Cmd/Ctrl + Shift selection → bulk move/delete (owner round 17).
    canSelectMany: true,
  });
  // Theme-aware count badges on path rows (git-decoration mechanism).
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(knowledge));
  const activity = new ActivityFeedProvider(manager);
  const activityView = vscode.window.createTreeView("pathrule.activityFeed", {
    treeDataProvider: activity,
  });
  context.subscriptions.push(knowledgeView, activityView);

  // Passive triggers (focus, realtime team edits, save) fire the whole-workspace
  // overview RPC + tree rebuild. When neither Pathrule view is visible that work
  // is invisible waste — defer it: mark dirty and flush once a view reopens.
  // syncActiveFile is cheap (reads the already-loaded tree) and feeds the status
  // bar, which is visible independent of the sidebar, so it always runs.
  let refreshPending = false;
  const viewsVisible = (): boolean => knowledgeView.visible || activityView.visible;
  const refreshViews = async (): Promise<void> => {
    if (viewsVisible()) {
      refreshPending = false;
      await Promise.all([knowledge.refresh(), activity.refresh()]);
    } else {
      refreshPending = true;
    }
    syncActiveFile();
  };
  const flushPendingRefresh = (): void => {
    if (refreshPending && viewsVisible()) void refreshViews();
  };
  context.subscriptions.push(
    knowledgeView.onDidChangeVisibility(flushPendingRefresh),
    activityView.onDidChangeVisibility(flushPendingRefresh),
  );

  // One coalescing scheduler for every passive trigger — focus, save,
  // realtime — so trigger bursts cost one overview RPC (review fix #10).
  // Binding changes stay immediate (mode switches must render now).
  let unsubscribeRemote: (() => void) | null = null;
  const scheduledRefresh = debounce(() => void refreshViews(), 500);
  context.subscriptions.push(
    new vscode.Disposable(
      manager.onDidChange((binding) => {
        void applyContextKeys(binding);
        void refreshViews();
        unsubscribeRemote?.();
        unsubscribeRemote =
          binding !== null && binding.kind === "cloud" && binding.onRemoteChange
            ? binding.onRemoteChange(() => scheduledRefresh())
            : null;
      }),
    ),
    new vscode.Disposable(() => unsubscribeRemote?.()),
  );

  // ── Active-file → path sync (signature interaction; design spec §4.1) ──
  const syncActiveFile = (): void => {
    const target = activeFileTarget(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
      manager.current(),
      knowledge.current(),
    );
    statusBar.setActivePath(target ? displayPath(target.relativePath) : null);
    statusBar.setCounts(target?.countsSummary ?? null);
    statusBar.setDelivery(target ? deliveryScopes(knowledge, target.relativePath) : null);
    const reveal = vscode.workspace.getConfiguration("pathrule").get<boolean>("revealActiveFile");
    if (reveal && target && knowledgeView.visible) {
      // The tree is a knowledge map — reveal the deepest covering path.
      const covering = knowledge.closest(target.relativePath);
      if (covering && covering.path !== "") {
        void knowledgeView.reveal(covering, { select: false, focus: false, expand: true });
      }
    }
  };
  const debouncedSync = debounce(syncActiveFile, REVEAL_DEBOUNCE_MS);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => debouncedSync()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) scheduledRefresh();
    }),
  );

  // ── pathrule:// virtual filesystem (markdown-tab CRUD) ──
  const fs = new PathruleFileSystem(manager);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("pathrule", fs, { isCaseSensitive: true }),
    fs.onDidSave.event(() => scheduledRefresh()),
  );

  registerContentCommands(context, {
    manager,
    fs,
    currentTreeNodeForActiveFile: () =>
      activeFileTarget(
        vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
        manager.current(),
        knowledge.current(),
      )?.relativePath ?? null,
    knowledgeTree: () => knowledge.current(),
    refresh: refreshViews,
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pathrule.explorerBadges")) knowledge.refreshDecorations();
    }),
  );

  // ── Agent integration (MCP provider + client installers + doctor) ──
  const bundledCliPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "cli",
    "dist",
    "index.js",
  ).fsPath;
  registerMcpProvider(context, manager, bundledCliPath);
  registerConnectCommand(context, manager, folder, bundledCliPath, cloud);
  registerDoctorCommand(context, manager, folder, bundledCliPath);

  registerOnboardingCommands(context, manager, folder, cloud);
  registerPushToCloud(context, manager, folder, cloud);
  registerQuickMenu(context, manager);
  registerCommands(context, manager, knowledgeView, refreshViews, syncActiveFile);

  // Async — never on the first-paint path.
  void manager.revalidate();
  scheduleUpdateChecks(context);
}

function registerCommands(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  knowledgeView: vscode.TreeView<KnowledgeElement>,
  refreshViews: () => Promise<void>,
  syncActiveFile: () => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.refresh", () => refreshViews()),
    vscode.commands.registerCommand("pathrule.revealActiveFile", async () => {
      const binding = manager.current();
      if (binding === null || binding.kind === "unbound") {
        await vscode.commands.executeCommand("pathrule.setUp");
        return;
      }
      await vscode.commands.executeCommand("pathrule.knowledgeTree.focus");
      syncActiveFile();
    }),
    vscode.commands.registerCommand("pathrule.copyNodePath", async (element?: KnowledgeElement) => {
      const path =
        element && element.kind === "path"
          ? element.path || "/"
          : (knowledgeView.selection[0] as { path?: string } | undefined)?.path || "/";
      await vscode.env.clipboard.writeText(path);
    }),
  );
}

/** Active path's delivery list (titles per scope, most specific first). */
function deliveryScopes(
  knowledge: KnowledgeTreeProvider,
  relativePath: string,
): Array<{ path: string; titles: string[] }> {
  const tree = knowledge.current();
  if (!tree) return [];
  const scopes: Array<{ path: string; titles: string[] }> = [];
  let path = relativePath;
  for (;;) {
    const node = tree.byPath.get(path === "/" ? "" : path);
    if (node && node.content.length > 0) {
      scopes.push({ path: node.path, titles: node.content.map((leaf) => leaf.label) });
    }
    if (path === "" || path === "/") break;
    path = path.slice(0, path.lastIndexOf("/"));
  }
  return scopes;
}

export function deactivateExtension(): Promise<void> {
  // Teardown is via context.subscriptions disposables, and the local store's host session.
  return closeLocalBinding();
}
