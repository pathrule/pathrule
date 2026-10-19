// SPDX-License-Identifier: Apache-2.0
// The open folder's edition, through the resolver every Pathrule surface uses
// (packages/core/src/workspace/folder-mode.ts), and the two places a person's choice of edition is
// recorded: the folder's own choice, and this device's default for new projects.
//
// The imports are DYNAMIC, as in ./local.ts: the resolver discovers Local stores with SQLite, which
// must stay off the activation path. Where SQLite cannot run in this extension host, no Local store
// is discovered here; a folder's recorded choice of Local still says the folder is Local.

import type { WorkspaceMatch } from "@pathrule/core/backend/inputs.js";
import type { FolderMode } from "@pathrule/core/workspace/folder-mode.js";

import type { FolderEdition } from "./types.js";

export interface ReadFolderModeOptions {
  /** Whether this build can serve Pathrule Cloud (it names one). */
  cloudAvailable: boolean;
  /** Whether the Local store can run in this extension host. */
  localAvailable: boolean;
  /** Test seam: the Local store discovery. */
  discoverLocal?: (cwd: string, env: NodeJS.ProcessEnv) => WorkspaceMatch | null;
}

/** The edition that serves `folder`. Reads files only. */
export async function readFolderMode(
  folder: string,
  env: NodeJS.ProcessEnv,
  options: ReadFolderModeOptions,
): Promise<FolderEdition> {
  const { folderConflictMessage, resolveFolderMode } =
    await import("@pathrule/core/workspace/folder-mode.js");
  const discoverLocal = options.localAvailable ? options.discoverLocal : () => null;
  const resolution = resolveFolderMode(folder, env, {
    cloudAvailable: options.cloudAvailable,
    ...(discoverLocal ? { discoverLocal } : {}),
  });
  return {
    ...resolution,
    conflictMessage: resolution.conflict ? folderConflictMessage(resolution.conflict) : null,
  };
}

/** Records `folder`'s own choice of edition: this project only. */
export async function recordProjectEdition(
  env: NodeJS.ProcessEnv,
  folder: string,
  mode: FolderMode,
): Promise<void> {
  const { recordFolderChoice } = await import("@pathrule/core/workspace/folder-mode.js");
  recordFolderChoice(env, folder, mode, "vscode");
}

/**
 * Sets this device's default edition for new projects: the `setup` field of
 * `capabilities/selection.json`, written with the CLI's own reader and writer
 * (packages/cli/src/capabilities/selection.ts). Only that field changes: the capabilities the CLI
 * loads stay as the person chose them, and an install that predates onboarding is mapped first, as
 * the CLI maps it. A folder with its own choice or workspace keeps its edition.
 */
export async function writeDeviceDefault(env: NodeJS.ProcessEnv, mode: FolderMode): Promise<void> {
  const { mapExistingInstall, readSelection, writeSelection } =
    await import("#cli/capabilities/selection.js");
  const base = readSelection(env) ??
    (await mapExistingInstall(env)) ?? { capabilities: [], source: "onboarding" as const };
  writeSelection(env, { capabilities: base.capabilities, setup: mode, source: base.source });
}
