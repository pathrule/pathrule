// SPDX-License-Identifier: Apache-2.0
// Pathrule Cloud for an editor (the VS Code extension's account seam,
// packages/vscode/src/cloud.ts): the folder's binding over its Project backend, the person's organizations, the setup plan, creating
// and attaching a workspace, and the folder's sync. The session is the one the CLI shares on this
// machine; the folders it attaches are the same list (./workspaces.ts).
import { randomUUID } from "node:crypto";
import { basename, relative, resolve, sep } from "node:path";

import type { KnowledgeBackend } from "@pathrule/core";
import { updateUserConfig } from "@pathrule/core/storage/config-store.js";

import { nativeCloudConfig } from "./config.js";
import { nativeCloudRuntime, type NativeCloudRuntime } from "./runtime.js";
import {
  currentOrganization,
  findWorkspace,
  NativeCloudError,
  nativeSession,
  organizations,
  workspacesOf,
  type NativeOrganization,
  type NativeWorkspace,
} from "./tenancy.js";
import { readNativeSession } from "./credentials.js";
import {
  attachNativeWorkspace,
  canonical,
  clearDisplacedFolders,
  nativeWorkspaceFor,
  readNativeWorkspaces,
} from "./workspaces.js";

export interface EditorBinding {
  backend: KnowledgeBackend;
  workspaceId: string;
  workspaceName: string;
  localRootPath: string;
  /** Leading-slash path of the folder inside the workspace ("" = its root). */
  relativePath: string;
}

export interface EditorOrganization {
  id: string;
  name: string;
  plan: string;
}

export interface EditorSetupCandidate {
  workspaceId: string;
  workspaceName: string;
  confidence: "exact" | "high" | "medium" | "low";
}

interface Deps {
  fetch?: typeof fetch;
}

// One runtime per environment: its composition is rebuilt when the session or the attached folders
// change, so the editor keeps it for its whole life.
const runtimes = new WeakMap<NodeJS.ProcessEnv, NativeCloudRuntime>();
function runtimeFor(env: NodeJS.ProcessEnv, deps: Deps): NativeCloudRuntime | null {
  const existing = runtimes.get(env);
  if (existing) return existing;
  const created = nativeCloudRuntime({ env, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  if (created) runtimes.set(env, created);
  return created;
}

const organization = (o: NativeOrganization): EditorOrganization => ({
  id: o.id,
  name: o.name,
  plan: o.plan ?? "unknown",
});

/** The Pathrule Cloud workspace serving `folder`, or null: nobody signed in, or not attached. */
export async function editorBinding(
  folder: string,
  env: NodeJS.ProcessEnv,
  deps: Deps = {},
): Promise<EditorBinding | null> {
  const runtime = runtimeFor(env, deps);
  const person = runtime ? await runtime.person() : null;
  const served = person ? nativeWorkspaceFor(person.workspaces, folder) : null;
  if (!runtime || !served) return null;
  const ctx = await runtime.projectAccount
    .resolveContext({ workspaceId: served.workspace_id, cwd: served.root })
    .catch(() => null);
  if (!ctx?.backend) return null;
  const inside = relative(served.root, resolve(folder));
  return {
    backend: ctx.backend,
    workspaceId: served.workspace_id,
    workspaceName: served.name,
    localRootPath: served.root,
    relativePath: inside ? `/${inside.split(sep).join("/")}` : "",
  };
}

/**
 * Why a Cloud folder's workspace did not open, so the editor says the right thing and offers the
 * right next step. Never a reason to serve the folder from Pathrule Local: there is none.
 *
 * - `signed-out`: no session on this machine, or the Cloud no longer accepts it (expired, revoked).
 * - `not-attached`: the person signed in has not attached this folder.
 * - `access-denied`: the Cloud refuses this account the workspace (removed, archived, deleted).
 * - `offline`: the Cloud did not answer (no network, DNS, a timeout).
 * - `cloud-error`: the Cloud answered with a failure of its own, or opened the workspace but its
 *   knowledge did not load.
 */
export type EditorCloudFailure =
  | "signed-out"
  | "not-attached"
  | "access-denied"
  | "offline"
  | "cloud-error";

export async function editorBindingFailure(
  folder: string,
  env: NodeJS.ProcessEnv,
  deps: Deps & { timeoutMs?: number } = {},
): Promise<EditorCloudFailure> {
  const session = await readNativeSession({ env }).catch(() => null);
  if (!session) return "signed-out";
  const served = nativeWorkspaceFor(
    await readNativeWorkspaces(session.user_id, env).catch(() => []),
    folder,
  );
  if (!served) return "not-attached";
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(
      new URL(`/v1/workspaces/${encodeURIComponent(served.workspace_id)}`, session.base_url),
      {
        headers: { authorization: `Bearer ${session.token}` },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      },
    );
  } catch {
    return "offline";
  }
  if (response.status === 401) return "signed-out";
  if (response.status === 403 || response.status === 404) return "access-denied";
  if (!response.ok) return "cloud-error";
  const workspace = (await response.json().catch(() => null)) as {
    archived_at?: unknown;
    deleted_at?: unknown;
  } | null;
  if (workspace?.archived_at || workspace?.deleted_at) return "access-denied";
  return "cloud-error";
}

export async function editorOrganizations(env: NodeJS.ProcessEnv, deps: Deps = {}) {
  const session = await nativeSession({ env, ...deps });
  return (await organizations(session.request)).map(organization);
}

export async function editorCurrentOrganization(env: NodeJS.ProcessEnv, deps: Deps = {}) {
  const session = await nativeSession({ env, ...deps });
  const current = await currentOrganization(session, env, false);
  return current ? organization(current) : null;
}

export async function editorUseOrganization(id: string, env: NodeJS.ProcessEnv, deps: Deps = {}) {
  const session = await nativeSession({ env, ...deps });
  if (!(await organizations(session.request)).some((o) => o.id === id))
    throw new NativeCloudError("organization_not_found", "That organization is not one of yours.");
  await updateUserConfig(session.userId, { current_org_id: id }, env);
}

/** The current organization's workspaces, best match for `folder` first. */
export async function editorSetupPlan(folder: string, env: NodeJS.ProcessEnv, deps: Deps = {}) {
  const session = await nativeSession({ env, ...deps });
  const current = await currentOrganization(session, env, false);
  if (!current) return { organizationName: null, candidates: [] as EditorSetupCandidate[] };
  const attached = (await session.runtime.person())?.workspaces ?? [];
  const name = basename(resolve(folder)).toLowerCase();
  const rank = { exact: 0, high: 1, medium: 2, low: 3 } as const;
  const candidates = (await workspacesOf(session.request, current.id))
    .map(
      (w): EditorSetupCandidate => ({
        workspaceId: w.id,
        workspaceName: w.name,
        // Attachments are stored canonical (symlinks resolved), so the folder is compared the same way.
        confidence: attached.some((e) => e.workspace_id === w.id && canonical(e.root) === canonical(folder))
          ? "exact"
          : w.name.toLowerCase() === name
            ? "high"
            : "low",
      }),
    )
    .sort(
      (a, b) =>
        rank[a.confidence] - rank[b.confidence] || a.workspaceName.localeCompare(b.workspaceName),
    );
  return { organizationName: current.name, candidates };
}

async function attach(
  session: Awaited<ReturnType<typeof nativeSession>>,
  workspace: NativeWorkspace,
  folder: string,
  env: NodeJS.ProcessEnv,
) {
  const before = await readNativeWorkspaces(session.userId, env);
  const entries = await attachNativeWorkspace(
    session.userId,
    {
      workspace_id: workspace.id,
      organization_id: workspace.organization_id,
      name: workspace.name,
      root: folder,
    },
    env,
  );
  // A folder the attach displaced keeps nothing of the workspace (workspaces.ts clearDisplacedFolders).
  await clearDisplacedFolders(before, entries.find((e) => e.workspace_id === workspace.id)!, env);
}

export async function editorCreateWorkspace(
  name: string,
  folder: string,
  env: NodeJS.ProcessEnv,
  deps: Deps = {},
) {
  const session = await nativeSession({ env, ...deps });
  const current = await currentOrganization(session, env, true);
  const created = await session.request<NativeWorkspace>(
    `/v1/organizations/${encodeURIComponent(current!.id)}/workspaces`,
    { name },
    "POST",
    randomUUID(),
  );
  await attach(session, created, folder, env);
}

export async function editorAttachWorkspace(
  selector: string,
  folder: string,
  env: NodeJS.ProcessEnv,
  deps: Deps = {},
) {
  const session = await nativeSession({ env, ...deps });
  await attach(session, await findWorkspace(session, env, selector), folder, env);
}

/** The CLI's native sync of `folder`: its agent files and its hook index. */
export async function editorSyncWorkspace(env: NodeJS.ProcessEnv, folder: string, deps: Deps = {}) {
  const session = await nativeSession({ env, ...deps });
  const { nativeSync } = await import("../cli/commands/native-knowledge.js");
  const quiet = { write: () => true };
  const outcome = await nativeSync(
    { cwd: folder, env, stdout: quiet, stderr: quiet, ...deps },
    session,
  );
  if ((outcome.exitCode ?? 0) !== 0) throw new Error(outcome.lines.join("\n"));
}

/** What an MCP server the editor starts needs to reach the same Pathrule Cloud: its public names. */
export function editorMcpServerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const config = nativeCloudConfig(env);
  return config
    ? {
        PATHRULE_NATIVE_CLOUD_URL: config.baseUrl,
        PATHRULE_NATIVE_DEVICE_CLIENT_ID: config.clientId,
      }
    : {};
}
