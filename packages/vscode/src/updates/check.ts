// SPDX-License-Identifier: Apache-2.0
// The extension's update check, on the vscode API: after activation (never on the first-paint path)
// and then once a day, it reads the signed release manifest the CLI also reads (shared state under
// the Pathrule home) and, only when the person must act, shows one notice whose buttons hand over
// to the editor: its extension page (Update) or its Restart Extensions. It never installs anything:
// the editor's extensions.autoUpdate installs, under either Pathrule policy, and under Notify only
// the notice says that Pathrule cannot hold back what the editor installs by itself.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  cachedReleaseManifest,
  fetchReleaseManifest,
  updateCheckDue,
} from "@pathrule/core/release/release-feed.js";
import { readUpdateState } from "@pathrule/core/release/update-state.js";
import { CLI_VERSION } from "#cli/cli-version.js";
import { getUpdatePolicy, updatesDisabled } from "#cli/config.js";

import { strings } from "../ui/strings.js";
import {
  autoUpdateSetting,
  EXTENSION_ID,
  extensionUpdateView,
  noticeShownRecently,
  pendingRestartVersion,
  type PathrulePolicy,
  type ExtensionAction,
  type ExtensionUpdateView,
} from "./extension-updates.js";

const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTICE_KEY = "pathrule.updateNotice";

function extensionVersion(context: vscode.ExtensionContext): string {
  return (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";
}

/** A newer Pathrule the editor installed beside this one and that waits for a restart, or null. */
function pendingRestart(context: vscode.ExtensionContext): string | null {
  try {
    const dir = path.dirname(context.extensionUri.fsPath);
    let obsolete = new Set<string>();
    try {
      obsolete = new Set(
        Object.keys(JSON.parse(readFileSync(path.join(dir, ".obsolete"), "utf8"))),
      );
    } catch {
      // No list of removed folders.
    }
    return pendingRestartVersion(readdirSync(dir), obsolete, extensionVersion(context));
  } catch {
    return null;
  }
}

/** What the extension knows now, from the manifest on disk: for the doctor, no network. */
export function currentUpdateView(
  context: vscode.ExtensionContext,
  policy: PathrulePolicy = "automatic",
): ExtensionUpdateView {
  return extensionUpdateView({
    manifest: cachedReleaseManifest(process.env)?.manifest ?? null,
    version: extensionVersion(context),
    cliVersion: CLI_VERSION,
    appName: vscode.env.appName,
    autoUpdate: autoUpdateSetting(
      vscode.workspace.getConfiguration("extensions").get("autoUpdate"),
    ),
    policy,
    pendingRestart: pendingRestart(context),
  });
}

/** Pathrule's update policy, as the CLI reads it (an account may store it). */
export async function pathrulePolicy(): Promise<PathrulePolicy> {
  return (await getUpdatePolicy(process.env).catch(() => null))?.value ?? "automatic";
}

/** The editor's own update checks are on, and Pathrule's technical switch is not set. */
function checksAllowed(): boolean {
  if (updatesDisabled(process.env)) return false;
  return vscode.workspace.getConfiguration("extensions").get("autoCheckUpdates") !== false;
}

async function checkOnce(context: vscode.ExtensionContext): Promise<void> {
  if (checksAllowed() && updateCheckDue(readUpdateState(process.env))) {
    await fetchReleaseManifest({
      env: process.env,
      userAgent: `pathrule-vscode/${extensionVersion(context)}`,
    });
  }
  const view = currentUpdateView(context, await pathrulePolicy());
  const notice = view.notice;
  if (!notice) return;
  const record = context.globalState?.get<{ key?: string; version?: string; at?: string }>(
    NOTICE_KEY,
  );
  if (noticeShownRecently(record, notice, new Date())) return;
  await context.globalState?.update(NOTICE_KEY, {
    key: notice.key,
    version: notice.version,
    at: new Date().toISOString(),
  });

  const labels: Record<ExtensionAction, string> = {
    update: strings.updates.update,
    restartExtensions: strings.updates.restartExtensions,
  };
  const show =
    notice.key === "vscode:update_required"
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
  const picked = await show(notice.message, ...notice.actions.map((action) => labels[action]));
  if (picked === labels.update) {
    // The editor's own extension page for Pathrule, with its Update button: VS Code or Open VSX.
    await vscode.commands.executeCommand("workbench.extensions.action.showExtensionsWithIds", [
      EXTENSION_ID,
    ]);
  } else if (picked === labels.restartExtensions) {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  }
}

/**
 * Start the checks: the first a little after activation, then daily. Only in a production
 * extension host: development, tests and the activation smoke never reach the network.
 */
export function scheduleUpdateChecks(context: vscode.ExtensionContext): void {
  const production = vscode.ExtensionMode?.Production;
  if (production === undefined || context.extensionMode !== production) return;
  const run = () => void checkOnce(context).catch(() => {});
  // Timers never keep a process alive: the extension host decides when it ends.
  const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
  const daily = setInterval(run, CHECK_INTERVAL_MS);
  first.unref?.();
  daily.unref?.();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(first);
      clearInterval(daily);
    }),
  );
}
