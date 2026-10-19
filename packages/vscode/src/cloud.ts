// SPDX-License-Identifier: Apache-2.0
// Pathrule Cloud for the VS Code extension: the account behind the extension's seam
// (./capabilities.ts). One session per machine, shared with the CLI
// (@pathrule/cloud/native/credentials.ts), and the folders it attached
// (@pathrule/cloud/native/editor-account.ts). A build or run that names no Pathrule Cloud
// (@pathrule/cloud/native/config.ts) has no account: every call says so.

import { cloudCliPlugin } from "@pathrule/cloud/cli/plugin.js";
import { nativeCloudConfig } from "@pathrule/cloud/native/config.js";
import {
  editorAttachWorkspace,
  editorBinding,
  editorBindingFailure,
  editorCreateWorkspace,
  editorCurrentOrganization,
  editorOrganizations,
  editorSetupPlan,
  editorSyncWorkspace,
  editorUseOrganization,
} from "@pathrule/cloud/native/editor-account.js";
import {
  loginNativeDevice,
  readNativeSession,
  signOutNative,
} from "@pathrule/cloud/native/credentials.js";

import type { BoundFolder } from "./binding/types.js";
import type { CloudSetupPlan, ExtensionCapabilities, ExtensionCloud } from "./capabilities.js";

function requireNativeCloud(env: NodeJS.ProcessEnv) {
  const native = nativeCloudConfig(env);
  if (!native) throw new Error("This build of the extension names no Pathrule Cloud.");
  return native;
}

async function nativePerson(env: NodeJS.ProcessEnv): Promise<string | null> {
  const session = await readNativeSession({ env }).catch(() => null);
  if (!session) return null;
  try {
    const response = await fetch(new URL("/api/auth/get-session", session.base_url), {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const body = (await response.json().catch(() => null)) as { user?: { email?: string } } | null;
    return body?.user?.email ?? session.user_id;
  } catch {
    return session.user_id;
  }
}

async function hasSession(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!nativeCloudConfig(env)) return false;
  return (await readNativeSession({ env }).catch(() => null)) !== null;
}

async function resolveBinding(folder: string, env: NodeJS.ProcessEnv): Promise<BoundFolder | null> {
  if (!(await hasSession(env))) return null;
  // Pathrule Cloud has no realtime channel: the tree refreshes when the extension reads it again.
  const bound = await editorBinding(folder, env);
  return bound ? { kind: "cloud", ...bound } : null;
}

function available(env: NodeJS.ProcessEnv): boolean {
  try {
    return nativeCloudConfig(env) !== null;
  } catch {
    return false;
  }
}

export const vscodeCloud: ExtensionCloud = {
  available,
  hasSession,
  resolveBinding,
  bindingFailure: (folder, env) => editorBindingFailure(folder, env).catch(() => "cloud-error" as const),
  // The session is already shared with the CLI: there is nothing to adopt.
  adoptableAccount: async () => null,
  adoptSession: async (env) => hasSession(env),
  // Pathrule Cloud's device flow: the browser opens the Cloud's approval page.
  signIn: async ({ env, onPending }) => {
    const native = requireNativeCloud(env);
    const result = await loginNativeDevice(
      {
        baseUrl: native.baseUrl,
        clientId: native.clientId,
        onCode: ({ user_code, verification_uri, verification_uri_complete }) =>
          onPending({
            userCode: user_code,
            verificationUri: verification_uri_complete ?? verification_uri,
          }),
      },
      { env },
    );
    return (await nativePerson(env)) ?? result.userId;
  },
  signOut: async (env) => {
    await signOutNative({ env });
  },
  organizations: async (env) => {
    requireNativeCloud(env);
    return editorOrganizations(env);
  },
  currentOrganization: async (env) => {
    requireNativeCloud(env);
    return editorCurrentOrganization(env);
  },
  useOrganization: async (id, env) => {
    requireNativeCloud(env);
    return editorUseOrganization(id, env);
  },
  setupPlan: async (folder, env): Promise<CloudSetupPlan> => {
    requireNativeCloud(env);
    return editorSetupPlan(folder, env);
  },
  createWorkspace: async (name, folder, env) => {
    requireNativeCloud(env);
    return editorCreateWorkspace(name, folder, env);
  },
  attachWorkspace: async (selector, folder, env) => {
    requireNativeCloud(env);
    return editorAttachWorkspace(selector, folder, env);
  },
  // The CLI's sync over the folder's Cloud workspace (hook script, settings hook, protocol file,
  // hook index, companion files).
  syncWorkspace: async (env, _workspaceId, folder) => {
    requireNativeCloud(env);
    return editorSyncWorkspace(env, folder);
  },
};

/**
 * What the extension composes: the Cloud CLI plugin (the hook extensions the CLI modules the
 * extension runs, sync and hook install, write beside the hook, and the account) and the account.
 */
export function cloudCapabilities(): ExtensionCapabilities {
  return { cliPlugins: [cloudCliPlugin()], cloud: vscodeCloud };
}
