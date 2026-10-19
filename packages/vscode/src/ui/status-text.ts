// SPDX-License-Identifier: Apache-2.0
// Pure status-bar text composition (design spec §4.3) — vscode-free for tests.

import type { FolderBinding, UnboundFolder } from "../binding/types.js";
import { icons } from "./icons.js";
import { strings } from "./strings.js";

export interface StatusBarModel {
  text: string;
  tooltip: string;
  command: string;
}

export function statusBarModel(
  binding: FolderBinding | null,
  activeRelativePath: string | null,
  countsSummary: string | null,
): StatusBarModel {
  if (binding === null) {
    return {
      text: `$(${icons.brand}) ${strings.statusBar.resolving}`,
      tooltip: strings.statusBar.setUpTooltip,
      command: "pathrule.setUp",
    };
  }
  if (binding.kind === "unbound") return unboundModel(binding);
  const shown = displayPath(activeRelativePath ?? binding.relativePath);
  const suffix = binding.kind === "local" ? strings.statusBar.localSuffix : "";
  return {
    text: `$(${icons.brand}) ${shown}${suffix}`,
    tooltip: strings.statusBar.boundTooltip(
      binding.workspaceName ?? "Pathrule workspace",
      binding.kind === "cloud" ? strings.statusBar.modeCloud : strings.statusBar.modeLocal,
      countsSummary ?? strings.counts.none,
    ),
    // Bound click = the Quick Menu hub (owner round 17).
    command: "pathrule.quickMenu",
  };
}

/**
 * An unbound folder: what to show and what a click does, by why it is unbound. A Cloud folder
 * that cannot be shown says so, and never offers the Local store in its place.
 */
/** What a Cloud folder whose workspace did not open says, by why. */
export function unreachableText(binding: UnboundFolder, workspace: string): string {
  switch (binding.cloudFailure) {
    case "offline":
      return strings.folder.offline(workspace);
    case "access-denied":
      return strings.folder.accessDenied(workspace);
    case "cloud-error":
      return strings.folder.cloudError(workspace);
    default:
      return strings.folder.unreachable(workspace);
  }
}

export function unboundModel(binding: UnboundFolder): StatusBarModel {
  const cloudName = binding.cloudWorkspace?.name ?? "Pathrule workspace";
  const brand = `$(${icons.brand})`;
  switch (binding.reason) {
    case "signed-out":
      return {
        text: `${brand} ${strings.statusBar.signIn}`,
        tooltip: strings.folder.signedOut(cloudName),
        command: "pathrule.signIn",
      };
    case "cloud-unreachable": {
      const cause = binding.cloudFailure;
      return {
        text: `${brand} ${
          cause === "offline"
            ? strings.statusBar.offline
            : cause === "access-denied"
              ? strings.statusBar.accessDenied
              : cause === "cloud-error"
                ? strings.statusBar.cloudError
                : strings.statusBar.unreachable
        }`,
        tooltip: unreachableText(binding, cloudName),
        command: "pathrule.setUp",
      };
    }
    case "cloud-unavailable":
      return {
        text: `${brand} ${strings.statusBar.cloudUnavailable}`,
        tooltip: strings.folder.cloudUnavailable,
        command: "pathrule.setUp",
      };
    case "local-unavailable":
      return {
        text: `${brand} ${strings.statusBar.localUnavailable}`,
        tooltip: strings.folder.localUnavailable,
        command: "pathrule.setUp",
      };
    case "conflict":
      return {
        text: `${brand} ${strings.statusBar.conflict}`,
        tooltip: binding.conflict?.message ?? strings.statusBar.setUpTooltip,
        command: "pathrule.setUp",
      };
    case "failed":
      return {
        text: `${brand} ${strings.statusBar.failed}`,
        tooltip: strings.folder.failed,
        command: "pathrule.setUp",
      };
    case "not-set-up":
      // Signed in elsewhere on this machine → one explicit click to connect,
      // never a blind "Set up" that could fork a duplicate workspace.
      if (binding.mode === "cloud" && binding.canAdopt && binding.adoptAccount) {
        return {
          text: `${brand} ${strings.statusBar.connect(binding.adoptAccount)}`,
          tooltip: strings.statusBar.connectTooltip(binding.adoptAccount),
          command: "pathrule.connectExisting",
        };
      }
      return {
        text: `${brand} ${strings.statusBar.setUp}`,
        tooltip: binding.mode
          ? strings.folder.setUp(
              binding.mode === "cloud" ? strings.edition.cloud : strings.edition.local,
            )
          : strings.statusBar.setUpTooltip,
        command: "pathrule.setUp",
      };
  }
}

/** Markdown tooltip body: the agent-eye delivery list for the active path. */
export function deliveryTooltipLines(
  scopes: Array<{ path: string; titles: string[] }>,
  maxItems = 10,
): string[] {
  const lines = [`**${strings.delivery.header}**`, ""];
  let shown = 0;
  let truncated = 0;
  for (const scope of scopes) {
    for (const title of scope.titles) {
      if (shown >= maxItems) {
        truncated += 1;
        continue;
      }
      lines.push(`- ${title} · ${scope.path || "/"}`);
      shown += 1;
    }
  }
  if (shown === 0) lines.push(strings.delivery.none);
  if (truncated > 0) lines.push(`- ${strings.delivery.more(truncated)}`);
  return lines;
}

/** "" (workspace root) renders as "/" — always show where you are. */
export function displayPath(relativePath: string): string {
  if (relativePath === "" || relativePath === "/") return "/";
  return relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
}
