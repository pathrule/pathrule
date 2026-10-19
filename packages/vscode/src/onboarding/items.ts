// SPDX-License-Identifier: Apache-2.0
// Pure onboarding QuickPick models (design spec §4.2) — vscode-free.

import { icons } from "../ui/icons.js";
import { strings } from "../ui/strings.js";

export type OnboardingAction =
  | { kind: "create-cloud" }
  | { kind: "attach"; selector: string; name: string }
  | { kind: "init-local" }
  | { kind: "sign-in-create" }
  | { kind: "switch-org" };

export interface OnboardingItemModel {
  label: string;
  description?: string;
  detail?: string;
  icon: keyof typeof icons;
  action: OnboardingAction;
}

export interface OnboardingState {
  folderName: string;
  /** Whether this build has Pathrule Cloud. Without it only local mode is offered. */
  cloudAvailable: boolean;
  hasSession: boolean;
  localAvailable: boolean;
  orgName: string | null;
  /** Existing cloud workspaces this folder matches (git remote / hook cache). */
  attachCandidates: Array<{ selector: string; name: string }>;
}

export function onboardingItems(state: OnboardingState): OnboardingItemModel[] {
  const items: OnboardingItemModel[] = [];

  if (!state.cloudAvailable) {
    // The open build: local mode is the whole offer, and needs no account.
    if (state.localAvailable) {
      items.push({
        label: strings.onboarding.initLocallyNoAccount,
        detail: strings.onboarding.initLocallyOpenDetail,
        icon: "local",
        action: { kind: "init-local" },
      });
    }
    return items;
  }

  if (state.hasSession) {
    // Bind-don't-duplicate guard: existing matches outrank creation.
    for (const candidate of state.attachCandidates) {
      items.push({
        label: strings.onboarding.bindExisting(candidate.name),
        detail: strings.onboarding.bindExistingDetail,
        icon: "cloud",
        action: { kind: "attach", selector: candidate.selector, name: candidate.name },
      });
    }
    if (state.orgName) {
      items.push({
        label: strings.onboarding.createInOrg(state.folderName, state.orgName),
        description:
          state.attachCandidates.length === 0 ? strings.onboarding.createRecommended : undefined,
        detail: strings.onboarding.createInOrgDetail,
        icon: "cloud",
        action: { kind: "create-cloud" },
      });
    }
  } else {
    items.push({
      label: strings.onboarding.signInCreate,
      detail: strings.onboarding.signInCreateDetail,
      icon: "cloud",
      action: { kind: "sign-in-create" },
    });
  }

  if (state.localAvailable) {
    items.push({
      label: state.hasSession
        ? strings.onboarding.initLocally
        : strings.onboarding.initLocallyNoAccount,
      detail: strings.onboarding.initLocallyDetail,
      icon: "local",
      action: { kind: "init-local" },
    });
  }

  if (state.hasSession) {
    items.push({
      label: strings.onboarding.switchOrg,
      icon: "organization",
      action: { kind: "switch-org" },
    });
  }

  return items;
}
