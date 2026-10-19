// SPDX-License-Identifier: Apache-2.0
// The MCP server's context for a call: which edition serves the call's folder, and that edition's
// store.
//
// One MCP entry serves every folder and names no edition, so each call's folder decides
// (core workspace/folder-mode.ts): its own recorded choice, else the Local workspace or Cloud
// attachment that already serves it, else the device default. A Local folder is served from its
// local store, which the home's Pathrule host owns: the server reaches it through one host session
// for its lifetime, which the composition that starts the server configures (`useHostSession`; the
// CLI's `mcp run` says how to launch the host). A Cloud folder is served by the installed Project
// account and by nothing else: when Pathrule Cloud cannot answer, the call fails with the step that
// fixes it, never with a Local store's knowledge in its place.

import { resolveLocalPrincipal } from "@pathrule/core";
import type { ToolContext, ToolErrorCode } from "@pathrule/core/tools/types.js";
import {
  folderConflictMessage,
  isCloudWorkspaceId,
  localStoreExists,
  resolveFolderMode,
  type FolderModeResolution,
} from "@pathrule/core/workspace/folder-mode.js";
import type { RemoteStore } from "@pathrule/host/remote-store.js";
import { HostSession } from "@pathrule/host/session.js";
import { resolveClientId } from "./client-identity.js";
import { mcpProjectAccount } from "./plugin.js";
import { callCwd } from "./lib/call-cwd.js";

let session: HostSession | null = null;

/**
 * The host session this server's local stores go through. The composition that starts the server
 * sets it (`startPathruleMcpServer({ hostLaunch })`); without one, the first use runs the host in
 * this process, as code used as a library does.
 */
export function useHostSession(next: HostSession | null): void {
  session = next;
  stores.clear();
}

export function localHostSession(env: NodeJS.ProcessEnv = process.env): HostSession {
  session ??= new HostSession({ env });
  return session;
}

// One store per workspace, reused across tool calls; the host keeps the SQLite handle open.
const stores = new Map<string, Promise<RemoteStore>>();

/** An error a tool reports under `code` (`formatThrown` keeps it), so an agent can tell the cases apart. */
function failure(code: ToolErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Why `workspaceId` names no Local store this server may open, or null when it names one. The host
 * creates a store it is asked for, so this is the one gate between a Cloud workspace's id (or any id
 * nothing created) and a new `<PATHRULE_HOME>/<id>/pathrule.db` holding Cloud knowledge.
 */
function localStoreRefusal(
  workspaceId: string,
  env: NodeJS.ProcessEnv,
): { code: ToolErrorCode; message: string } | null {
  if (isCloudWorkspaceId(workspaceId, env)) {
    const message = `${workspaceId} is a Pathrule Cloud workspace: it is served by Pathrule Cloud, never from a Pathrule Local store.`;
    return { code: "invalid_args", message };
  }
  if (!localStoreExists(workspaceId, env)) {
    const message = `No Pathrule Local workspace ${workspaceId} exists on this machine. Run \`pathrule init --local\` in the project folder to create one.`;
    return { code: "not_found", message };
  }
  return null;
}

function getOrOpenBackend(workspaceId: string, env: NodeJS.ProcessEnv): Promise<RemoteStore> {
  let store = stores.get(workspaceId);
  if (!store) {
    const refused = localStoreRefusal(workspaceId, env);
    if (refused) return Promise.reject(failure(refused.code, refused.message));
    store = localHostSession(env).store(workspaceId);
    stores.set(workspaceId, store);
    store.catch(() => stores.delete(workspaceId));
  }
  return store;
}

/**
 * The raw local store of an existing Local workspace. Exposed for V30 outcome observation: the
 * drain (`ingestObservationsFromDisk`) is a LocalBackend-specific method that is deliberately OFF
 * the cloud-facing `KnowledgeBackend` interface (observation stays local, never syncs), so a caller
 * that needs it must reach the store rather than `ctx.backend`. Rejects a Cloud workspace's id and
 * an id with no store, so no caller creates one.
 */
export function getLocalBackend(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RemoteStore> {
  return getOrOpenBackend(workspaceId, env);
}

/** Test/shutdown seam: forget every store and end the session (a host it ran stops). */
export async function resetLocalBackends(): Promise<void> {
  stores.clear();
  const current = session;
  session = null;
  await current?.close();
}

// Contexts the Project account served, so a local-only step (the hook's observation ledger) can tell
// that the workspace id is an account's, not a local store's.
const projectContexts = new WeakSet<ToolContext>();

/** Whether `ctx` is an account's Project context (`McpPlugin.projectAccount`), not a local store. */
export function isProjectContext(ctx: ToolContext): boolean {
  return projectContexts.has(ctx);
}

/**
 * The semantic ranking endpoint the hook index of an account's Project carries
 * (`McpProjectAccount.semanticEndpoint`); none for a local store.
 */
export function projectSemanticEndpoint(
  ctx: ToolContext,
): { url: string; native: true } | undefined {
  return isProjectContext(ctx)
    ? (mcpProjectAccount()?.semanticEndpoint?.() ?? undefined)
    : undefined;
}

/**
 * The context of a call: the edition that serves the call's folder (`resolveFolderMode`), and only
 * that one. A folder in conflict, a Cloud folder this server cannot serve and a Local folder with no
 * workspace each fail with the command that fixes them. An error the Project account throws (signed
 * out, no access, offline) reaches the caller as it is.
 */
export async function resolveOpenContext(
  workspaceId: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolContext> {
  const project = mcpProjectAccount();
  const cwd = callCwd() ?? process.cwd();
  const folder = resolveFolderMode(cwd, env, { cloudAvailable: project !== null });
  if (folder.conflict) throw failure("conflict", folderConflictMessage(folder.conflict));
  if (folder.mode === "local") return localContext(folder, workspaceId, env);
  const where = folder.root ?? folder.cwd;
  if (!project) {
    throw failure(
      "upstream_error",
      `${where} uses Pathrule Cloud, and this Pathrule MCP server cannot reach Pathrule Cloud: the ` +
        `Pathrule Cloud plugin is not loaded. Nothing is served from a Pathrule Local store instead. ` +
        `Run \`pathrule setup --cloud\` to set Pathrule Cloud up on this machine, or \`pathrule doctor\` ` +
        `to see what is missing.`,
    );
  }
  const ctx = await project.resolveContext({ workspaceId, cwd });
  if (!ctx) {
    throw failure(
      "auth_required",
      `${where} uses Pathrule Cloud, and no Pathrule Cloud workspace serves it for a signed-in ` +
        `account. Sign in with \`pathrule login\`, or attach this folder to a Pathrule Cloud workspace ` +
        `with \`pathrule setup --cloud\`. Nothing is served from a Pathrule Local store instead.`,
    );
  }
  const served: ToolContext = { ...ctx, clientId: ctx.clientId ?? resolveClientId() };
  projectContexts.add(served);
  return served;
}

/**
 * A Local folder's context: the folder's own Local workspace. An explicit `workspaceId` is checked
 * whatever the folder holds, so a Cloud workspace's id or one with no store fails out loud instead
 * of being ignored; it serves only a folder with no workspace of its own, as before.
 */
async function localContext(
  folder: FolderModeResolution,
  workspaceId: string | null,
  env: NodeJS.ProcessEnv,
): Promise<ToolContext> {
  const refused = workspaceId ? localStoreRefusal(workspaceId, env) : null;
  if (refused) {
    throw failure(
      refused.code,
      `${refused.message} ${folder.root ?? folder.cwd} uses Pathrule Local: call without workspace_id ` +
        `to use its workspace.`,
    );
  }
  const served = folder.local?.workspaceId ?? workspaceId;
  if (!served) {
    throw failure(
      "not_found",
      "No Pathrule Local workspace covers this folder. Run `pathrule init --local` here first, or " +
        "`pathrule setup --local` to set Pathrule Local up for this project.",
    );
  }
  return {
    backend: await getOrOpenBackend(served, env),
    userId: resolveLocalPrincipal(env),
    workspaceId: served,
    clientId: resolveClientId(),
  };
}
