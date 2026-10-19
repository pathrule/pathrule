// SPDX-License-Identifier: Apache-2.0
// The person's organizations and workspaces on Pathrule Cloud (the Worker's `/v1` tenancy routes),
// for the CLI's account commands and the VS Code extension: the signed-in session, the current
// organization (the one chosen, else the only one) and a workspace by name or id.
import { readUserConfig } from "@pathrule/core/storage/config-store.js";

import { nativeCloudRuntime, nativeRequest, type NativeCloudRuntime } from "./runtime.js";

export interface NativeOrganization {
  id: string;
  name: string;
  revision: number;
  role: string;
  plan: string | null;
}

export interface NativeWorkspace {
  id: string;
  organization_id: string;
  name: string;
  access_mode?: string;
  revision?: number;
}

export type NativeRequest = NonNullable<Awaited<ReturnType<typeof nativeRequest>>>["request"];

/** What the person can do next, as a command or a page. */
export interface NativeNextStep {
  label: string;
  command?: string;
  url?: string;
}

/** A refusal with a stable code and the step that resolves it. */
export class NativeCloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next?: NativeNextStep[],
  ) {
    super(message);
  }
}

/** The person, their requests, and the runtime that serves their folders. */
export interface NativeSessionContext {
  runtime: NativeCloudRuntime;
  userId: string;
  request: NativeRequest;
}

/** The signed-in person on the Cloud this build or run names; refuses when there is none. */
export async function nativeSession(input: {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}): Promise<NativeSessionContext> {
  const runtime = nativeCloudRuntime({
    env: input.env,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!runtime)
    throw new NativeCloudError(
      "pathrule_cloud_not_configured",
      "This build names no Pathrule Cloud.",
    );
  const person = await nativeRequest(runtime);
  if (!person)
    throw new NativeCloudError("not_authenticated", "Not signed in to Pathrule Cloud.", [
      { label: "Sign in", command: "pathrule login" },
    ]);
  return { runtime, userId: person.userId, request: person.request };
}

export async function organizations(request: NativeRequest): Promise<NativeOrganization[]> {
  return (await request<{ items: NativeOrganization[] }>("/v1/organizations")).items;
}

export async function workspacesOf(
  request: NativeRequest,
  organizationId: string,
): Promise<NativeWorkspace[]> {
  return (
    await request<{ items: NativeWorkspace[] }>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/workspaces`,
    )
  ).items;
}

export function pick<T extends { id: string; name: string }>(
  items: T[],
  selector: string,
): T | null {
  const wanted = selector.trim().toLowerCase();
  return (
    items.find((i) => i.id === selector) ??
    items.find((i) => i.name.toLowerCase() === wanted) ??
    null
  );
}

/** The organization commands act in: the one chosen with `org use`, else the only one. */
export async function currentOrganization(
  session: NativeSessionContext,
  env: NodeJS.ProcessEnv,
  required: boolean,
): Promise<NativeOrganization | null> {
  const all = await organizations(session.request);
  const chosen = (await readUserConfig(session.userId, env)).current_org_id;
  const current = all.find((o) => o.id === chosen) ?? (all.length === 1 ? all[0] : null);
  if (!current && required) {
    throw all.length === 0
      ? new NativeCloudError("organization_required", "You have no organization yet.", [
          { label: "Create one", command: "pathrule org create <name>" },
        ])
      : new NativeCloudError("organization_required", "Choose an organization first.", [
          { label: "Choose one", command: "pathrule org use <name-or-id>" },
        ]);
  }
  return current ?? null;
}

/** A workspace by name or id: in the current organization first, then in any of the person's. */
export async function findWorkspace(
  session: NativeSessionContext,
  env: NodeJS.ProcessEnv,
  selector: string,
): Promise<NativeWorkspace> {
  const current = await currentOrganization(session, env, false);
  const orgs = current
    ? [current, ...(await organizations(session.request)).filter((o) => o.id !== current.id)]
    : await organizations(session.request);
  for (const org of orgs) {
    const found = pick(await workspacesOf(session.request, org.id), selector);
    if (found) return found;
  }
  throw new NativeCloudError(
    "workspace_not_found",
    `No workspace "${selector}" in your organizations.`,
    [{ label: "List workspaces", command: "pathrule workspace list" }],
  );
}
