// SPDX-License-Identifier: Apache-2.0
/**
 * `pathrule status`: which edition serves this folder and why, the device default, the workspace
 * that answers, and anything the person must act on. Pathrule Cloud adds its account lines (who is
 * signed in, whether the Cloud workspace answers). Read-only: it writes nothing and attaches nothing.
 *
 * Exits 1 when the folder cannot be served as it stands: a conflict between a Local workspace and
 * a Cloud workspace, or a Cloud folder the account cannot serve now. Never 1 for a folder that is
 * simply not set up yet.
 */
import type { FolderModeResolution } from "@pathrule/core/workspace/folder-mode.js";

import { EDITION_TITLE, editionReason, folderEdition } from "../capabilities/folder-edition.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import { cliAccount, type CliCommand, type CliRuntime, type CliStatusSection } from "../plugin.js";

export const statusCommand: CliCommand = {
  name: "status",
  help: {
    section: "diagnostics",
    rank: 10,
    summary: "Show this folder's edition, its workspace, the device default and what needs attention",
  },
  jsonRank: 45,
  run: (ctx) => renderStatus(ctx.runtime, ctx.mode),
  json: (ctx) => statusJson(ctx.runtime),
};

const DEFAULT_SOURCE = {
  chosen: "chosen",
  "new-install": "the default for a new install",
  "no-cloud": "this build names no Pathrule Cloud",
} as const;

interface StatusReport {
  folder: FolderModeResolution;
  account: CliStatusSection | null;
  problem: { code: string; message: string; next?: string } | null;
}

async function report(runtime: CliRuntime): Promise<StatusReport> {
  const folder = folderEdition(runtime.cwd, runtime.env);
  const account = cliAccount();
  const section = account?.status ? await account.status(runtime.env, runtime.cwd, folder).catch(() => null) : null;
  if (folder.conflict) {
    return {
      folder,
      account: section,
      problem: {
        code: "folder_edition_conflict",
        message: `${folder.conflict.root} has both a Pathrule Local workspace and a Pathrule Cloud workspace, and no choice between them.`,
        next: "pathrule setup --cloud  or  pathrule setup --local",
      },
    };
  }
  if (folder.mode === "cloud" && !account) {
    return {
      folder,
      account: null,
      problem: {
        code: "cloud_unavailable",
        message: "This folder uses Pathrule Cloud, and Pathrule Cloud is not available in this run. Nothing is served from a Local store in its place.",
        next: "pathrule doctor",
      },
    };
  }
  // A folder only the device default speaks for is not set up yet: what the account says about it
  // (signed out, not attached) is shown, not counted as a problem.
  const own = folder.source === "project" || folder.source === "workspace";
  return { folder, account: section, problem: folder.mode === "cloud" && own ? (section?.problem ?? null) : null };
}

function workspaceLine(folder: FolderModeResolution): string {
  if (folder.mode === "local") {
    return folder.local
      ? `Pathrule Local workspace ${folder.local.workspaceId} at ${folder.local.localRootPath}`
      : "none yet (run `pathrule setup --local` here)";
  }
  if (folder.mode === "cloud") {
    return folder.cloud
      ? `Pathrule Cloud workspace "${folder.cloud.name}" (${folder.cloud.workspaceId}), attached at ${folder.cloud.root}`
      : "none attached on this machine (run `pathrule setup` here)";
  }
  return "conflict";
}

async function renderStatus(runtime: CliRuntime, mode: CliOutputMode): Promise<number> {
  const { folder, account, problem } = await report(runtime);
  const out = (line: string) => runtime.stdout.write(`${line}\n`);
  out("Pathrule status");
  out(`  Folder:          ${folder.cwd}`);
  if (folder.mode) {
    out(`  Edition:         ${EDITION_TITLE[folder.mode]} (${editionReason(folder)}${folder.root && folder.root !== folder.cwd ? `, set at ${folder.root}` : ""})`);
  } else {
    out("  Edition:         none: Local and Cloud workspaces conflict here");
  }
  out(`  Device default:  ${EDITION_TITLE[folder.deviceDefault.mode]} (${DEFAULT_SOURCE[folder.deviceDefault.source]})`);
  out(`  Workspace:       ${workspaceLine(folder)}`);
  if (folder.dormant.local && folder.mode === "cloud") {
    out(`  Kept, not used:  Local workspace ${folder.dormant.local.workspaceId}, while this folder is a Pathrule Cloud folder`);
  }
  if (folder.dormant.cloud && folder.mode === "local") {
    out(`  Kept, not used:  Pathrule Cloud workspace "${folder.dormant.cloud.name}", while this folder is a Pathrule Local folder`);
  }
  for (const line of account?.lines ?? []) out(`  ${line}`);
  if (!problem && account?.problem && folder.mode === "cloud") {
    out(`  Not set up yet:  ${account.problem.message}${account.problem.next ? ` (${account.problem.next})` : ""}`);
  }
  if (problem) {
    runtime.stdout.write(`${statusLabel("error", mode)} ${problem.message}\n`);
    if (problem.next) runtime.stdout.write(`Next: ${problem.next}\n`);
    return 1;
  }
  return 0;
}

async function statusJson(runtime: CliRuntime) {
  const { folder, account, problem } = await report(runtime);
  return {
    exitCode: problem ? 1 : 0,
    envelope: jsonEnvelope({
      command: "status",
      cwd: runtime.cwd,
      ok: !problem,
      data: {
        folder: { cwd: folder.cwd, mode: folder.mode, source: folder.source, root: folder.root },
        device_default: folder.deviceDefault,
        workspace:
          folder.mode === "local" && folder.local
            ? { edition: "local", id: folder.local.workspaceId, root: folder.local.localRootPath }
            : folder.mode === "cloud" && folder.cloud
              ? { edition: "cloud", id: folder.cloud.workspaceId, name: folder.cloud.name, organization_id: folder.cloud.organizationId, root: folder.cloud.root }
              : null,
        dormant: {
          local: folder.dormant.local?.workspaceId ?? null,
          cloud: folder.dormant.cloud?.workspaceId ?? null,
        },
        conflict: folder.conflict,
        account: account?.data ?? null,
      },
      ...(problem
        ? { error: { code: problem.code, message: problem.message, ...(problem.next ? { remediation: [{ label: "Next", command: problem.next }] } : {}) } }
        : {}),
    }),
  };
}
