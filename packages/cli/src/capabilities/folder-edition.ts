// SPDX-License-Identifier: Apache-2.0
/**
 * The CLI's side of "one edition per folder" (core/workspace/folder-mode.ts): which edition serves
 * the folder a command runs in, and what a command does when that edition cannot answer.
 *
 * A command that works on knowledge runs in the folder's edition and nowhere else. A Cloud folder
 * is never served from a Local store, whatever exists on disk: when Pathrule Cloud is not available
 * in this run, the command says so and stops. `--local` and `--cloud` on these commands no longer
 * pick an edition for one run; they state which one the person expects, and a mismatch stops with
 * the command that changes the folder (`pathrule setup --local` or `--cloud`).
 */
import { nativeCloudConfig } from "@pathrule/cloud/native/config.js";
import {
  folderConflictMessage,
  resolveFolderMode,
  type FolderMode,
  type FolderModeResolution,
} from "@pathrule/core/workspace/folder-mode.js";

import { jsonEnvelope, statusLabel } from "../output.js";
import {
  cliAccount,
  type CliCommand,
  type CliCommandContext,
  type CliJsonResult,
  type CliLocalCommand,
} from "../plugin.js";

/** Whether this build or this run names a Pathrule Cloud to sign in to. */
export function cloudNamed(env: NodeJS.ProcessEnv): boolean {
  try {
    return nativeCloudConfig(env) !== null;
  } catch {
    return false;
  }
}

export function folderEdition(cwd: string, env: NodeJS.ProcessEnv): FolderModeResolution {
  return resolveFolderMode(cwd, env, { cloudAvailable: cloudNamed(env) });
}

export const EDITION_TITLE: Readonly<Record<FolderMode, string>> = {
  cloud: "Pathrule Cloud",
  local: "Pathrule Local",
};

export interface EditionRefusal {
  code: string;
  message: string;
  next?: string;
}

export type EditionRoute =
  | { kind: "account"; command: CliCommand; folder: FolderModeResolution }
  | { kind: "open"; folder: FolderModeResolution }
  | { kind: "refused"; refusal: EditionRefusal };

/** Why the folder's edition reads the way it does, for messages. */
export function editionReason(folder: FolderModeResolution): string {
  if (folder.source === "project") return "this project's choice";
  if (folder.source === "workspace") return "its workspace";
  return folder.deviceDefault.source === "chosen" ? "the device default" : "the default for a new install";
}

/** The edition refusal for a folder in conflict, or null. */
export function conflictRefusal(folder: FolderModeResolution): EditionRefusal | null {
  if (!folder.conflict) return null;
  return {
    code: "folder_edition_conflict",
    message: folderConflictMessage(folder.conflict),
    next: "pathrule setup --cloud",
  };
}

/**
 * Where a knowledge command (`sync`, `search`, `memory`, `rule`, `skill`) runs for this folder: the
 * account's command for a Cloud folder, the open one for a Local folder, or a refusal.
 */
export function editionRoute(ctx: CliCommandContext): EditionRoute {
  const folder = folderEdition(ctx.runtime.cwd, ctx.runtime.env);
  const conflict = conflictRefusal(folder);
  if (conflict) return { kind: "refused", refusal: conflict };
  const mode = folder.mode!;
  const expected = ctx.flags.local ? "local" : ctx.flags.cloud ? "cloud" : null;
  if (expected && expected !== mode) {
    const where = folder.root ?? ctx.runtime.cwd;
    return {
      kind: "refused",
      refusal: {
        code: mode === "cloud" ? "folder_is_cloud" : "folder_is_local",
        message:
          `${where} uses ${EDITION_TITLE[mode]} (${editionReason(folder)}), so --${expected} does not ` +
          `apply here. Commands follow the folder's edition; to change it for this folder, run ` +
          `\`pathrule setup --${expected}\`.`,
        next: `pathrule setup --${expected}`,
      },
    };
  }
  if (mode === "local") return { kind: "open", folder };
  const command = cliAccount()?.commands[ctx.command as CliLocalCommand];
  if (!command) {
    return {
      kind: "refused",
      refusal: {
        code: "cloud_unavailable",
        message:
          `${folder.root ?? ctx.runtime.cwd} uses Pathrule Cloud (${editionReason(folder)}), and ` +
          `Pathrule Cloud is not available in this run. Nothing is served from a Local store in its ` +
          `place. Check with \`pathrule doctor\`, or set this folder up locally: \`pathrule setup --local\`.`,
        next: "pathrule doctor",
      },
    };
  }
  return { kind: "account", command, folder };
}

/** Prints a refusal and returns the exit code: 64 for a usage mismatch, 1 otherwise. */
export function renderRefusal(ctx: CliCommandContext, refusal: EditionRefusal): number {
  ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${refusal.message}\n`);
  return refusalExit(refusal);
}

export function refusalJson(ctx: CliCommandContext, refusal: EditionRefusal): CliJsonResult {
  return {
    exitCode: refusalExit(refusal),
    envelope: jsonEnvelope({
      command: ctx.command,
      cwd: ctx.runtime.cwd,
      ok: false,
      error: {
        code: refusal.code,
        message: refusal.message,
        ...(refusal.next ? { remediation: [{ label: "Next", command: refusal.next }] } : {}),
      },
    }),
  };
}

function refusalExit(refusal: EditionRefusal): number {
  return refusal.code === "folder_is_cloud" || refusal.code === "folder_is_local" ? 64 : 1;
}

/** A command that runs in the folder's edition: the account's for a Cloud folder, `open` otherwise. */
export function editionCommand(
  open: { run: (ctx: CliCommandContext) => Promise<number>; json: (ctx: CliCommandContext) => Promise<CliJsonResult> },
): Pick<CliCommand, "run" | "json"> {
  return {
    run: async (ctx) => {
      const route = editionRoute(ctx);
      if (route.kind === "refused") return renderRefusal(ctx, route.refusal);
      return route.kind === "account" ? route.command.run(ctx) : open.run(ctx);
    },
    json: async (ctx) => {
      const route = editionRoute(ctx);
      if (route.kind === "refused") return refusalJson(ctx, route.refusal);
      if (route.kind === "open") return open.json(ctx);
      // A Cloud command with no JSON form answers that, never the Local command's JSON in its place.
      return (
        (await route.command.json?.(ctx)) ??
        refusalJson(ctx, {
          code: "json_unsupported",
          message: `\`pathrule ${ctx.command}\` has no JSON form for a Pathrule Cloud folder.`,
        })
      );
    },
  };
}
