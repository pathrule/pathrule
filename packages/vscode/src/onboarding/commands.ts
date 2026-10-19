// SPDX-License-Identifier: Apache-2.0
// Onboarding + auth + org switcher (design spec §4.2). The account is the build's Pathrule Cloud
// capability (../capabilities.ts), which reuses the CLI's pipeline verbatim: login persists to the
// SHARED ~/.pathrule credential store (one identity across CLI / MCP / extension); org selection
// flows through the shared config store, so the CLI follows. A build without the capability
// offers local mode only, and its account commands say so.
//
// The folder's edition (Pathrule Cloud or Local) is the one every Pathrule surface resolves. Setup
// that picks the other edition asks for the scope first (./edition.ts): this project only, or this
// device's default for new projects. Choosing a scope never copies anything.

import * as path from "node:path";

import type { FolderMode } from "@pathrule/core/workspace/folder-mode.js";
import * as vscode from "vscode";

import { recordProjectEdition, writeDeviceDefault } from "../binding/folder-mode.js";
import type { BindingManager } from "../binding/manager.js";
import { localModeAvailable } from "../binding/local.js";
import type { FolderEdition, UnboundFolder } from "../binding/types.js";
import { requireCloud, type ExtensionCloud } from "../capabilities.js";
import { themeIcon } from "../ui/theme.js";
import { unreachableText } from "../ui/status-text.js";
import { strings } from "../ui/strings.js";
import {
  actionEdition,
  editionName,
  editionScopeItems,
  editionStep,
  scopeChangesFolder,
} from "./edition.js";
import { onboardingItems, type OnboardingAction, type OnboardingItemModel } from "./items.js";

export function registerOnboardingCommands(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  folder: string | null,
  cloud: ExtensionCloud | null,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.signIn", () =>
      cloud ? signIn(manager, cloud) : cloudUnavailable(),
    ),
    vscode.commands.registerCommand("pathrule.signOut", () =>
      cloud ? signOut(manager, cloud) : cloudUnavailable(),
    ),
    vscode.commands.registerCommand("pathrule.switchOrganization", () =>
      cloud ? switchOrganization(cloud) : cloudUnavailable(),
    ),
    vscode.commands.registerCommand("pathrule.setUp", () => setUp(manager, folder, cloud)),
    vscode.commands.registerCommand("pathrule.connectExisting", () =>
      cloud ? connectExisting(manager, folder, cloud) : setUp(manager, folder, cloud),
    ),
    vscode.commands.registerCommand("pathrule.openTeamOnWeb", () => openWeb()),
    vscode.commands.registerCommand("pathrule.useCloudForFolder", () =>
      cloud ? useEdition(manager, folder, "cloud") : cloudUnavailable(),
    ),
    vscode.commands.registerCommand("pathrule.useLocalForFolder", () =>
      useEdition(manager, folder, "local"),
    ),
  );
}

/**
 * Settles the folder's edition before setup acts on `requested`. Resolves true when setup goes on
 * for this folder: the folder already uses it, or now does. False when the person cancelled, or
 * chose the device default and this folder keeps its own edition.
 */
async function decideEdition(
  manager: BindingManager,
  folder: string,
  requested: FolderMode,
  current: FolderEdition | null,
): Promise<boolean> {
  const step = editionStep(current?.mode ?? null, requested);
  if (step === "same") return true;
  if (step === "record-project") {
    await recordProjectEdition(process.env, folder, requested);
    return true;
  }
  const picked = await vscode.window.showQuickPick(
    editionScopeItems(requested, path.basename(folder)),
    { title: strings.edition.scopeTitle(editionName(requested)), ignoreFocusOut: true },
  );
  if (!picked) return false;
  if (picked.scope === "project") {
    await recordProjectEdition(process.env, folder, requested);
    return true;
  }
  await writeDeviceDefault(process.env, requested);
  if (scopeChangesFolder(current!.source, "device")) return true;
  void vscode.window.showInformationMessage(
    strings.edition.deviceOnly(editionName(requested), editionName(current!.mode!)),
  );
  await manager.revalidate();
  return false;
}

/** "Use Pathrule Cloud/Local for This Folder": the edition alone, then setup when it needs one. */
async function useEdition(
  manager: BindingManager,
  folder: string | null,
  requested: FolderMode,
): Promise<void> {
  if (!folder) return;
  let current: FolderEdition | null;
  try {
    current = await manager.folderEdition();
  } catch {
    void vscode.window.showErrorMessage(strings.folder.failed);
    return;
  }
  if (current?.mode === requested) {
    void vscode.window.showInformationMessage(strings.edition.alreadyUses(editionName(requested)));
    return;
  }
  if (!(await decideEdition(manager, folder, requested, current))) return;
  const binding = await manager.revalidate();
  if (binding && binding.kind !== "unbound") {
    void vscode.window.showInformationMessage(strings.edition.nowUses(editionName(requested)));
    return;
  }
  // No workspace of that edition serves the folder yet (or it cannot be shown): setup says what next.
  await vscode.commands.executeCommand("pathrule.setUp");
}

/**
 * A folder whose workspace cannot be shown, for a reason setup must not paper over: the person
 * acts on it (sign in, try again, choose an edition). Resolves true when onboarding should go on.
 */
async function explainUnbound(
  manager: BindingManager,
  folder: string,
  binding: UnboundFolder,
  cloud: ExtensionCloud | null,
): Promise<boolean> {
  const name = binding.cloudWorkspace?.name ?? "Pathrule workspace";
  switch (binding.reason) {
    case "conflict": {
      const choice = await vscode.window.showWarningMessage(
        binding.conflict?.message ?? strings.statusBar.conflict,
        strings.edition.useCloud,
        strings.edition.useLocal,
      );
      if (choice === strings.edition.useCloud) {
        await vscode.commands.executeCommand("pathrule.useCloudForFolder");
      } else if (choice === strings.edition.useLocal) {
        await vscode.commands.executeCommand("pathrule.useLocalForFolder");
      }
      return false;
    }
    case "signed-out": {
      const choice = await vscode.window.showInformationMessage(
        strings.folder.signedOut(name),
        strings.folder.signIn,
      );
      if (choice === strings.folder.signIn && cloud) await signIn(manager, cloud);
      return false;
    }
    case "cloud-unreachable":
    case "failed": {
      const choice = await vscode.window.showWarningMessage(
        binding.reason === "failed" ? strings.folder.failed : unreachableText(binding, name),
        strings.folder.tryAgain,
        // Another account is the way on only when this one has no access (or the cause is unknown).
        ...(binding.reason === "cloud-unreachable" &&
        (binding.cloudFailure === undefined || binding.cloudFailure === "access-denied")
          ? [strings.folder.signIn]
          : []),
      );
      if (choice === strings.folder.tryAgain) await manager.revalidate();
      else if (choice === strings.folder.signIn && cloud) await signIn(manager, cloud);
      return false;
    }
    case "cloud-unavailable":
    case "local-unavailable":
      // The other edition is the only way on here, and choosing it asks for the scope.
      void vscode.window.showWarningMessage(
        binding.reason === "cloud-unavailable"
          ? strings.folder.cloudUnavailable
          : strings.folder.localUnavailable,
      );
      return true;
    case "not-set-up":
      return true;
  }
}

/** An account command in a build without Pathrule Cloud: say so, and report nothing done. */
function cloudUnavailable(): false {
  void vscode.window.showInformationMessage(strings.onboarding.cloudUnavailable);
  return false;
}

/**
 * One-click connect for a folder that's already set up while the user is signed
 * in on Desktop/CLI. Adopts the existing session into VSCode's own slot (an
 * EXPLICIT gesture that clears the migration-block marker), then revalidates.
 * If the folder is attached to a workspace it binds silently; if the session is
 * adopted but no workspace matches, it falls through to the normal setup picker
 * (attach/create). No device-code round-trip, no duplicate workspace.
 */
async function connectExisting(
  manager: BindingManager,
  folder: string | null,
  cloud: ExtensionCloud,
): Promise<void> {
  const adopted = await cloud.adoptSession(process.env).catch(() => false);
  if (!adopted) {
    // Nothing adoptable (session expired/revoked) — fall back to a real login.
    await signIn(manager, cloud);
    return;
  }
  const binding = await manager.revalidate();
  if (binding && binding.kind !== "unbound") {
    void vscode.window.showInformationMessage(
      strings.onboarding.boundExisting(
        binding.workspaceName ?? "Pathrule workspace",
        binding.relativePath || "/",
      ),
    );
    return;
  }
  // Signed in now, but this folder isn't attached to any workspace yet → setup.
  await setUp(manager, folder, cloud);
}

function webBase(): string {
  return (
    vscode.workspace.getConfiguration("pathrule").get<string>("webUrl")?.replace(/\/+$/, "") ||
    "https://app.pathrule.io"
  );
}

/** Team management, billing and org admin all live in the web app — the
 *  app root is the right landing for every org-scoped action. */
async function openWeb(route = ""): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(`${webBase()}${route}`));
}

/**
 * Sign-in = the CLI's DEFAULT device-code flow (owner review round 11): the
 * browser opens pathrule.io's hosted login, where the user picks ANY method
 * (GitHub, Google, email). The extension polls in the background; the
 * one-time code shows in the progress notification as a fallback.
 */
async function signIn(manager: BindingManager, cloud: ExtensionCloud): Promise<boolean> {
  try {
    const account = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: strings.onboarding.signingIn,
      },
      (progress) =>
        cloud.signIn({
          env: process.env,
          onPending: ({ userCode, verificationUri }) => {
            progress.report({ message: strings.onboarding.signInCode(userCode) });
            void vscode.env.openExternal(
              vscode.Uri.parse(verificationUriWithCode(verificationUri, userCode)),
            );
          },
        }),
    );
    void vscode.window.showInformationMessage(strings.onboarding.signedIn(account));
    await manager.revalidate();
    return true;
  } catch (error) {
    // Never silent (code-review fix #7): timeout/denied/network must be
    // distinguishable from a user cancel.
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    void vscode.window.showErrorMessage(`${strings.onboarding.signInFailed}${detail}`);
    return false;
  }
}

function verificationUriWithCode(verificationUri: string, userCode: string): string {
  try {
    const url = new URL(verificationUri);
    url.searchParams.set("code", userCode);
    return url.toString();
  } catch {
    return verificationUri;
  }
}

async function signOut(manager: BindingManager, cloud: ExtensionCloud): Promise<void> {
  // Sign out only VSCode's slot; the CLI stays signed in.
  await cloud.signOut(process.env);
  void vscode.window.showInformationMessage(strings.onboarding.signedOut);
  await manager.revalidate();
}

async function switchOrganization(cloud: ExtensionCloud): Promise<boolean> {
  const [orgs, current] = await Promise.all([
    cloud.organizations(process.env),
    cloud.currentOrganization(process.env),
  ]);
  const picked = await vscode.window.showQuickPick(
    [
      ...orgs.map((org) => ({
        label: org.name,
        description: org.id === current?.id ? strings.onboarding.orgCurrent : undefined,
        detail: org.plan,
        iconPath: themeIcon("organization"),
        orgId: org.id as string | null,
      })),
      {
        label: strings.onboarding.manageTeamOnWeb,
        iconPath: themeIcon("cloud"),
        orgId: null,
        description: undefined,
        detail: undefined,
      },
    ],
    { title: strings.onboarding.orgPickTitle, ignoreFocusOut: true },
  );
  if (!picked) return false;
  if (picked.orgId === null) {
    await openWeb();
    return false;
  }
  await cloud.useOrganization(picked.orgId, process.env);
  return true;
}

async function setUp(
  manager: BindingManager,
  folder: string | null,
  cloud: ExtensionCloud | null,
): Promise<void> {
  if (!folder) return;
  // A folder bound from another surface (CLI/desktop) connects instantly.
  const existing = await manager.revalidate();
  if (existing && existing.kind !== "unbound") {
    void vscode.window.showInformationMessage(
      strings.onboarding.boundExisting(
        existing.workspaceName ?? "Pathrule workspace",
        existing.relativePath || "/",
      ),
    );
    return;
  }

  const binding = existing;
  if (binding?.kind === "unbound" && !(await explainUnbound(manager, folder, binding, cloud))) {
    return;
  }
  const hasSession = binding?.kind === "unbound" ? binding.hasSession : false;
  const localAvailable =
    binding?.kind === "unbound" ? binding.localAvailable : await localModeAvailable();

  let orgName: string | null = null;
  let attachCandidates: Array<{ selector: string; name: string }> = [];
  if (hasSession && cloud) {
    try {
      const plan = await cloud.setupPlan(folder, process.env);
      orgName = plan.organizationName;
      attachCandidates = plan.candidates
        .filter((c) => c.confidence === "exact" || c.confidence === "high")
        .slice(0, 3)
        .map((c) => ({ selector: c.workspaceId, name: c.workspaceName }));
    } catch {
      // Plan failure degrades to plain create/local choices.
    }
  }

  const models = onboardingItems({
    folderName: path.basename(folder),
    cloudAvailable: cloud !== null,
    hasSession,
    localAvailable,
    orgName,
    attachCandidates,
  });
  if (models.length === 0) {
    void vscode.window.showWarningMessage(
      cloud ? strings.onboarding.localUnavailable : strings.onboarding.localUnavailableNoCloud,
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({ ...m, iconPath: themeIcon(m.icon) })),
    { title: strings.onboarding.pickTitle, ignoreFocusOut: true },
  );
  if (!picked) return;
  let item = picked as OnboardingItemModel;
  // Footgun guard: this folder already matches an existing workspace, so
  // "create new" would silently fork a duplicate. Make the user confirm, and
  // default the safe action (connect to the match).
  const match = attachCandidates[0];
  if (picked.action.kind === "create-cloud" && match) {
    const choice = await vscode.window.showWarningMessage(
      strings.onboarding.createDespiteMatch(match.name),
      { modal: true },
      strings.onboarding.connectMatch(match.name),
      strings.onboarding.createAnyway,
    );
    if (choice === strings.onboarding.connectMatch(match.name)) {
      item = {
        ...item,
        action: { kind: "attach", selector: match.selector, name: match.name },
      };
    } else if (choice !== strings.onboarding.createAnyway) {
      return; // dismissed → no-op
    }
  }
  // Another edition than the folder's: the scope comes first. The same edition asks nothing.
  const requested = actionEdition(item.action);
  if (requested) {
    let current: FolderEdition | null;
    try {
      current = await manager.folderEdition();
    } catch {
      void vscode.window.showErrorMessage(strings.folder.failed);
      return;
    }
    if (!(await decideEdition(manager, folder, requested, current))) return;
  }
  await runAction(item, manager, folder, cloud);
}

async function runAction(
  item: OnboardingItemModel,
  manager: BindingManager,
  folder: string,
  cloud: ExtensionCloud | null,
): Promise<void> {
  const action: OnboardingAction = item.action;
  switch (action.kind) {
    case "sign-in-create": {
      if (await signIn(manager, requireCloud(cloud))) {
        await vscode.commands.executeCommand("pathrule.setUp");
      }
      return;
    }
    case "switch-org": {
      if (await switchOrganization(requireCloud(cloud))) {
        await vscode.commands.executeCommand("pathrule.setUp");
      }
      return;
    }
    case "create-cloud":
    case "attach":
    case "init-local": {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: strings.onboarding.progressTitle,
          },
          async () => {
            if (action.kind === "create-cloud") {
              await requireCloud(cloud).createWorkspace(path.basename(folder), folder, process.env);
            } else if (action.kind === "attach") {
              await requireCloud(cloud).attachWorkspace(action.selector, folder, process.env);
            } else {
              // Lazy: this module statically imports LocalBackend (sqlite) —
              // it must never load on the activation path (lazy-sqlite rule).
              const { initLocalWorkspace } = await import("#cli/local/init-local.js");
              await initLocalWorkspace({ cwd: folder, env: process.env });
            }
            await manager.revalidate();
          },
        );
      } catch {
        const retry = await vscode.window.showErrorMessage(
          strings.onboarding.setupFailed,
          strings.onboarding.retry,
        );
        if (retry === strings.onboarding.retry) {
          await vscode.commands.executeCommand("pathrule.setUp");
        }
        return;
      }
      // The single toast of the flow (notification budget).
      const choice = await vscode.window.showInformationMessage(
        strings.onboarding.readyToast,
        strings.onboarding.readyConnect,
        strings.onboarding.readyLater,
      );
      if (choice === strings.onboarding.readyConnect) {
        await vscode.commands.executeCommand("pathrule.connectAgents");
      }
      return;
    }
  }
}
