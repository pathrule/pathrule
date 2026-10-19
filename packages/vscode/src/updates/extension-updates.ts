// SPDX-License-Identifier: Apache-2.0
// What the signed release manifest says about this extension, decided without the vscode API so
// it is tested like any module. The editor keeps installing extension updates itself (its
// extensions.autoUpdate); Pathrule only tells the person what applies to them and opens the
// editor's own update path.

import { PATHRULE_CONTRACTS } from "@pathrule/protocol/compatibility.js";
import {
  assessComponent,
  assessServiceContracts,
  isNewerVersion,
  type ReleaseManifest,
} from "@pathrule/protocol/release-manifest.js";

import { strings } from "../ui/strings.js";

export const EXTENSION_ID = "pathrule.pathrule-vscode";

export type ExtensionDistribution = "vscode-marketplace" | "open-vsx";

/** Microsoft's VS Code installs from the VS Code Marketplace; its forks install from Open VSX. */
export function extensionDistribution(appName: string): ExtensionDistribution {
  return /^Visual Studio Code\b/.test(appName) ? "vscode-marketplace" : "open-vsx";
}

/** The editor's `extensions.autoUpdate`: on, off, or only for extensions the person selected. */
export type AutoUpdate = "on" | "off" | "selected";

export function autoUpdateSetting(value: unknown): AutoUpdate {
  if (value === false || value === "false") return "off";
  if (value === "onlySelectedExtensions") return "selected";
  return "on";
}

export type ExtensionAction = "update" | "restartExtensions";

export type PathrulePolicy = "automatic" | "notify";

const TARGET_SUFFIX = /-(?:win32|linux|alpine|darwin)-(?:x64|arm64|armhf|ia32)$|-web$/i;
const FOLDER = /^pathrule\.pathrule-vscode-(.+)$/i;

/**
 * A newer Pathrule the editor already installed beside this one, waiting for Restart Extensions:
 * the highest `pathrule.pathrule-vscode-<version>[-<target>]` folder in the extensions directory,
 * leaving out folders the editor marked obsolete. Null when there is none.
 */
export function pendingRestartVersion(
  folders: readonly string[],
  obsolete: ReadonlySet<string>,
  running: string,
): string | null {
  let best: string | null = null;
  for (const folder of folders) {
    if (obsolete.has(folder)) continue;
    const match = FOLDER.exec(folder);
    if (!match) continue;
    const version = match[1]!.replace(TARGET_SUFFIX, "");
    if (!isNewerVersion(version, running)) continue;
    if (!best || isNewerVersion(version, best)) best = version;
  }
  return best;
}

export interface ExtensionUpdateView {
  version: string;
  cliVersion: string;
  distribution: ExtensionDistribution;
  autoUpdate: AutoUpdate;
  /** The release this extension's own marketplace verifiably published; null when unknown. */
  latest: string | null;
  status: "up_to_date" | "update_available" | "update_required" | "unknown";
  /** A notice for the person, or null when there is nothing they need to do. */
  notice: { key: string; version: string; message: string; actions: ExtensionAction[] } | null;
  /** One line for the doctor: versions, channel, update setting. */
  summary: string;
}

export function extensionUpdateView(input: {
  manifest: ReleaseManifest | null;
  version: string;
  cliVersion: string;
  appName: string;
  autoUpdate: AutoUpdate;
  /** Pathrule's own policy (`update.policy`). The editor installs extensions; this decides wording. */
  policy?: PathrulePolicy;
  /** A newer version the editor installed and that waits for Restart Extensions. */
  pendingRestart?: string | null;
}): ExtensionUpdateView {
  const policy = input.policy ?? "automatic";
  const distribution = extensionDistribution(input.appName);
  const assessed = input.manifest
    ? assessComponent(input.manifest, {
        component: "vscode",
        distribution,
        track: "latest",
        installedVersion: input.version,
      })
    : null;
  const cloud = input.manifest
    ? assessServiceContracts(input.manifest, "cloud", PATHRULE_CONTRACTS)
    : ({ ok: true } as const);
  const latest = assessed?.latest?.version ?? null;
  const required =
    assessed?.status === "update_required" || (!cloud.ok && cloud.reason === "client_outdated");
  const status = required
    ? "update_required"
    : assessed?.status === "update_available"
      ? "update_available"
      : assessed?.status === "up_to_date" || assessed?.status === "ahead"
        ? "up_to_date"
        : "unknown";

  let notice: ExtensionUpdateView["notice"] = null;
  if (input.pendingRestart) {
    // The editor already installed it: only a restart of the extension host activates it.
    notice = {
      key: "vscode:restart",
      version: input.pendingRestart,
      message: strings.updates.restartToActivate(input.pendingRestart),
      actions: ["restartExtensions"],
    };
  } else if (status === "update_required") {
    notice = {
      key: "vscode:update_required",
      version: latest ?? input.version,
      message: strings.updates.required,
      // With automatic updates on, the editor may already hold the new version, waiting for a restart.
      actions: input.autoUpdate === "on" ? ["restartExtensions", "update"] : ["update"],
    };
  } else if (status === "update_available" && latest) {
    if (input.autoUpdate !== "on") {
      // The editor waits for the person: Pathrule points at its update page, never installs.
      notice = {
        key: "vscode:update_available",
        version: latest,
        message: strings.updates.available(latest, input.version),
        actions: ["update"],
      };
    } else if (policy === "notify") {
      // Notify only cannot hold back what the editor installs by itself: say so, once.
      notice = {
        key: "vscode:host_updates",
        version: latest,
        message: strings.updates.hostUpdatesAnyway(latest),
        actions: ["update"],
      };
    }
    // Automatic, with the editor updating extensions: it installs it and asks for the restart.
  }

  return {
    version: input.version,
    cliVersion: input.cliVersion,
    distribution,
    autoUpdate: input.autoUpdate,
    latest,
    status,
    notice,
    summary: strings.updates.summary({
      version: input.version,
      cliVersion: input.cliVersion,
      marketplace: distribution === "vscode-marketplace" ? "VS Code Marketplace" : "Open VSX",
      autoUpdate: input.autoUpdate,
      latest,
      policy,
    }),
  };
}

const REPEAT_MS = 24 * 60 * 60 * 1000;

/** Whether a notice was already shown for this version within a day. */
export function noticeShownRecently(
  record: { key?: string; version?: string; at?: string } | undefined,
  notice: { key: string; version: string },
  now: Date,
): boolean {
  if (!record || record.key !== notice.key || record.version !== notice.version || !record.at) {
    return false;
  }
  const age = now.getTime() - Date.parse(record.at);
  return age >= 0 && age < REPEAT_MS;
}
