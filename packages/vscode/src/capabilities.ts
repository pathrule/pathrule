// SPDX-License-Identifier: Apache-2.0
// What the composition root adds to the extension's foundation. The extension reaches Pathrule
// Cloud only through this seam: the root (./extension.ts) composes it (./cloud.ts), and the tests
// of local mode compose none (OPEN_CAPABILITIES). Both are bundled from the same commit, so the
// seam carries no contract version.

import type { CommandPlugin } from "#cli/plugin.js";

import type { BoundFolder } from "./binding/types.js";

export interface ExtensionCapabilities {
  /**
   * The CLI plugins installed in the extension host. The CLI modules the extension runs (sync,
   * hook install) then find the engine in the core slot and write the plugins' hook extensions.
   */
  cliPlugins: readonly CommandPlugin[];
  /** Pathrule Cloud: the account, its organizations and workspaces. Null when the build has none. */
  cloud: ExtensionCloud | null;
}

export interface CloudOrganization {
  id: string;
  name: string;
  plan: string;
}

export interface CloudSetupPlan {
  organizationName: string | null;
  /** The cloud workspaces this folder may belong to, best first. */
  candidates: Array<{
    workspaceId: string;
    workspaceName: string;
    confidence: "exact" | "high" | "medium" | "low";
  }>;
}

/** Why a Cloud folder's workspace did not open (@pathrule/cloud/native/editor-account.ts). */
export type CloudFailure = "signed-out" | "not-attached" | "access-denied" | "offline" | "cloud-error";

/**
 * The Pathrule Cloud account as the extension uses it. Every session read and write goes to the
 * extension's own session slot, so signing in or out elsewhere never changes this one.
 */
export interface ExtensionCloud {
  /** Whether this build or run names a Pathrule Cloud. Never throws. */
  available(env: NodeJS.ProcessEnv): boolean;
  /** Whether the extension's slot holds a session. Never throws. */
  hasSession(env: NodeJS.ProcessEnv): Promise<boolean>;
  /**
   * The cloud workspace this folder is attached to, opened for the signed-in person, or null: no
   * session, not attached for them, or it did not open (offline, no access).
   */
  resolveBinding(folder: string, env: NodeJS.ProcessEnv): Promise<BoundFolder | null>;
  /**
   * Why `resolveBinding` gave null for a Cloud folder: one request that tells offline, signed out
   * (or a session the Cloud no longer accepts), no access, and a Cloud failure apart. Never throws.
   */
  bindingFailure?(folder: string, env: NodeJS.ProcessEnv): Promise<CloudFailure>;
  /** The account of a session another surface holds that this one may adopt. Never throws. */
  adoptableAccount(env: NodeJS.ProcessEnv): Promise<string | null>;
  /** Adopts that session into the extension's slot. False when there was none to adopt. */
  adoptSession(env: NodeJS.ProcessEnv): Promise<boolean>;
  /** The device-code sign-in. Resolves with the account to show, rejects when it did not finish. */
  signIn(input: {
    env: NodeJS.ProcessEnv;
    onPending: (pending: { userCode: string; verificationUri: string }) => void;
  }): Promise<string>;
  signOut(env: NodeJS.ProcessEnv): Promise<void>;
  organizations(env: NodeJS.ProcessEnv): Promise<CloudOrganization[]>;
  currentOrganization(env: NodeJS.ProcessEnv): Promise<CloudOrganization | null>;
  useOrganization(id: string, env: NodeJS.ProcessEnv): Promise<void>;
  setupPlan(folder: string, env: NodeJS.ProcessEnv): Promise<CloudSetupPlan>;
  createWorkspace(name: string, folder: string, env: NodeJS.ProcessEnv): Promise<void>;
  attachWorkspace(selector: string, folder: string, env: NodeJS.ProcessEnv): Promise<void>;
  /** Writes the folder's hooks and companion files for its cloud workspace (the CLI's sync). */
  syncWorkspace(env: NodeJS.ProcessEnv, workspaceId: string, folder: string): Promise<void>;
}

/** No plugin, no account: local mode alone, which is complete without them. */
export const OPEN_CAPABILITIES: ExtensionCapabilities = { cliPlugins: [], cloud: null };

/** The account, for a path only a cloud binding or a cloud onboarding action can reach. */
export function requireCloud(cloud: ExtensionCloud | null): ExtensionCloud {
  if (!cloud) throw new Error("Pathrule Cloud is not part of this build of the extension.");
  return cloud;
}
