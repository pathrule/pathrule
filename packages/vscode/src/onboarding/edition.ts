// SPDX-License-Identifier: Apache-2.0
// Changing a folder's edition (Pathrule Cloud or Local): pure decisions, vscode-free. A change
// offers exactly two scopes, this project only (the default) or this device's default for new
// projects, and choosing one never approves a data transfer.

import type { FolderMode, FolderModeResolution } from "@pathrule/core/workspace/folder-mode.js";

import { strings } from "../ui/strings.js";
import type { OnboardingAction } from "./items.js";

export type EditionScope = "project" | "device";

/** What choosing `requested` for a folder whose edition is `current` asks of the person. */
export type EditionStep =
  /** Already the folder's edition: nothing to ask, nothing recorded. */
  | "same"
  /** Another edition: ask for the scope. */
  | "ask-scope"
  /** A folder in conflict: the choice is this folder's, a device default would not settle it. */
  | "record-project";

export function editionStep(current: FolderMode | null, requested: FolderMode): EditionStep {
  if (current === null) return "record-project";
  return current === requested ? "same" : "ask-scope";
}

/**
 * Whether the folder itself changes edition with the scope chosen. The device default changes only
 * new projects: a folder with its own choice or workspace keeps its edition, and only a folder that
 * follows the default (none of its own) moves with it.
 */
export function scopeChangesFolder(
  source: FolderModeResolution["source"],
  scope: EditionScope,
): boolean {
  return scope === "project" || source === "device-default";
}

/** The edition an onboarding action sets up, or null for one that sets up nothing. */
export function actionEdition(action: OnboardingAction): FolderMode | null {
  switch (action.kind) {
    case "create-cloud":
    case "attach":
    case "sign-in-create":
      return "cloud";
    case "init-local":
      return "local";
    case "switch-org":
      return null;
  }
}

export interface ScopeItemModel {
  label: string;
  detail: string;
  scope: EditionScope;
}

/** The scope quick pick, this project first (the default). */
export function editionScopeItems(requested: FolderMode, folderName: string): ScopeItemModel[] {
  return [
    {
      label: strings.edition.projectScope,
      detail: strings.edition.projectScopeDetail(folderName, editionName(requested)),
      scope: "project",
    },
    {
      label: strings.edition.deviceScope,
      detail: strings.edition.deviceScopeDetail(editionName(requested)),
      scope: "device",
    },
  ];
}

export function editionName(mode: FolderMode): string {
  return mode === "cloud" ? strings.edition.cloud : strings.edition.local;
}
