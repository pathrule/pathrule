// SPDX-License-Identifier: Apache-2.0
// The native Pathrule Cloud for the Host, the MCP server and the hook, opt-in and Node-only: it wraps
// the native account (./account.ts) over the native binding (./client/native-binding.ts). The caller
// supplies the credentials and the workspace mappings; nothing here discovers either.
import { pathStartsWith } from "@pathrule/protocol/path-compare.js";
import { createHash } from "node:crypto";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import type { HostPlugin } from "@pathrule/host/plugin.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { createNativeAccount, type NativeWorkspaceMapping } from "./account.js";
import { cloudHttp, CloudHttpError, type CloudTransport } from "./client/http.js";
import { resolveCloudNativeBinding } from "./client/native-binding.js";
import type { CloudEmbeddingSpace } from "./client/semantic.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface NativeCloudCompositionOptions {
  /** Return the same snapshot until credentials change; null is an explicit logout. */
  transport(): Promise<CloudTransport | null>;
  mappings: readonly NativeWorkspaceMapping[];
  env: NodeJS.ProcessEnv;
  embeddingSpace?: CloudEmbeddingSpace;
  serveProjectBackend?: boolean;
}

export function createNativeCloudComposition(options: NativeCloudCompositionOptions) {
  let snapshot: CloudTransport | null = null;
  let owner: string | null = null;
  let initialized = false;
  let accessVersion: string | null = null;
  const mappedIds = [...new Set(options.mappings.map((m) => m.cloudWorkspaceId))].sort();
  if (mappedIds.length > 100) throw new Error("At most 100 explicit native workspace mappings");
  const allowedWorkspaces = new Set(
    options.mappings.flatMap((m) => [m.localWorkspaceId, m.cloudWorkspaceId]),
  );
  async function invalidate() {
    await account.signOut();
    accessVersion = null;
  }
  // Recheck the actual session before the Host consults its rendered-turn cache. The Foundation
  // account's five-minute binding cache alone is not a credential revocation boundary.
  async function current() {
    const transport = await options.transport();
    const first = !initialized;
    initialized = true;
    if (!first && transport !== snapshot) {
      await invalidate();
      owner = null;
    }
    snapshot = transport;
    if (!transport) {
      if (first) await invalidate();
      return null;
    }
    try {
      const identity = await cloudHttp(transport)<{ userId: string }>("/v1/me/identity");
      if (!identity.userId) throw new Error("Native authenticated owner required");
      if (owner !== null && owner !== identity.userId) await invalidate();
      const pinned = {
        ...transport,
        headers: async () => ({
          ...(await transport.headers()),
          "x-native-owner": identity.userId,
        }),
      };
      const access = await cloudHttp(pinned)<{
        items: {
          id: string;
          state: string;
          revision: number | null;
          organizationId: string | null;
        }[];
      }>("/v1/me/workspace-access", { ids: mappedIds });
      if (
        access.items.length !== mappedIds.length ||
        access.items.some(
          (item, i) =>
            item.id !== mappedIds[i] ||
            !["active", "archived", "deleted", "unavailable"].includes(item.state),
        )
      )
        throw new Error("Invalid native workspace access snapshot");
      const activeWorkspaces = new Set(
        access.items
          .filter(
            (item) =>
              item.state === "active" &&
              options.mappings.some(
                (mapping) =>
                  mapping.cloudWorkspaceId === item.id &&
                  (mapping.cloudOrganizationId === undefined ||
                    mapping.cloudOrganizationId === item.organizationId),
              ),
          )
          .map((item) => item.id),
      );
      const version = hash(access.items);
      if (accessVersion !== null && accessVersion !== version) await account.signOut();
      accessVersion = version;
      owner = identity.userId;
      return { transport, userId: owner, activeWorkspaces, version };
    } catch (error) {
      if (error instanceof CloudHttpError && [401, 403].includes(error.status)) {
        await invalidate();
        owner = null;
        return null;
      }
      throw error;
    }
  }
  const account = createNativeAccount({
    mappings: options.mappings,
    env: options.env,
    serveProjectBackend: options.serveProjectBackend,
    provider: {
      async resolveBinding(mapping) {
        const active = await current();
        return active?.activeWorkspaces.has(mapping.cloudWorkspaceId)
          ? resolveCloudNativeBinding({
              transport: active.transport,
              mapping,
              embeddingSpace: options.embeddingSpace,
            })
          : null;
      },
    },
  });
  const base = account.edition();
  const edition: ReturnType<typeof account.edition> = {
    ...base,
    async identity() {
      const active = await current();
      return active ? "native:" + active.userId + ":" + active.version : "signed-out";
    },
    async resolveBackend(cwd) {
      const active = await current();
      if (!active) return null;
      const resolved = await base.resolveBackend(cwd),
        after = await current();
      return resolved?.mapping &&
        after?.userId === active.userId &&
        after.version === active.version &&
        after.activeWorkspaces.has(resolved.mapping.cloudWorkspaceId)
        ? resolved
        : null;
    },
    async personal(input) {
      const active = await current(),
        workspace =
          input.resolved.mapping?.cloudWorkspaceId ??
          options.mappings.find((m) =>
            [m.localWorkspaceId, m.cloudWorkspaceId].includes(input.workspaceId),
          )?.cloudWorkspaceId;
      if (!active || !workspace || !active.activeWorkspaces.has(workspace)) return null;
      const value = await base.personal!(input),
        after = await current();
      return after?.userId === active.userId &&
        after.version === active.version &&
        after.activeWorkspaces.has(workspace)
        ? value
        : null;
    },
    turnContext: {
      ...base.turnContext,
      async sections(input) {
        const active = await current(),
          workspace =
            input.resolved.mapping?.cloudWorkspaceId ??
            options.mappings.find((m) =>
              [m.localWorkspaceId, m.cloudWorkspaceId].includes(input.workspaceId),
            )?.cloudWorkspaceId;
        if (!active || !workspace || !active.activeWorkspaces.has(workspace))
          throw new Error("Native workspace is no longer current");
        const sections = await base.turnContext.sections(input),
          after = await current();
        if (
          after?.userId !== active.userId ||
          after.version !== active.version ||
          !after.activeWorkspaces.has(workspace)
        )
          throw new Error("Native workspace changed during delivery");
        return sections;
      },
    },
  };
  const person = account.personalAccount();
  const personalAccount = {
    async bind(workspaceId: string) {
      // McpPersonalAccount.bind explicitly never throws when its provider is unavailable.
      try {
        const active = await current(),
          workspace = options.mappings.find((m) =>
            [m.localWorkspaceId, m.cloudWorkspaceId].includes(workspaceId),
          )?.cloudWorkspaceId;
        if (!active || !workspace || !active.activeWorkspaces.has(workspace)) return null;
        const value = await person.bind(workspaceId),
          after = await current();
        return after?.userId === active.userId &&
          after.version === active.version &&
          after.activeWorkspaces.has(workspace)
          ? value
          : null;
      } catch {
        return null;
      }
    },
  };
  const project = account.projectAccount();
  const projectAccount = project && {
    async resolveContext(input: Parameters<typeof project.resolveContext>[0]) {
      // A cached Foundation binding is not an authorization boundary. MCP can call this
      // without the Host's identity/resolveBackend path, so validate on every resolution.
      if (input.workspaceId && !allowedWorkspaces.has(input.workspaceId)) {
        throw new Error("Explicit native workspace mapping required");
      }
      if (
        !input.workspaceId &&
        !options.mappings.some((mapping) => {
          const root = mapping.localRootPath;
          return root !== undefined && pathStartsWith(input.cwd, root);
        })
      )
        return null;
      const active = await current();
      if (!active) throw new Error("Native session required for Project access");
      const context = await project.resolveContext(input);
      const after = await current();
      if (
        context &&
        (context.userId !== active.userId ||
          after?.userId !== active.userId ||
          after.version !== active.version ||
          !after.activeWorkspaces.has(context.workspaceId!))
      ) {
        throw new Error("Native owner or workspace changed during Project resolution");
      }
      return context;
    },
  };
  const plugin: HostPlugin = {
    name: "native-cloud",
    contract: HOST_PLUGIN_CONTRACT,
    sharedPackages: [CORE_PACKAGE, INTEGRATIONS_PACKAGE],
    activate(context) {
      context.provideAccount(edition);
    },
    deactivate: invalidate,
  };
  const securedAccount: typeof account = {
    ...account,
    edition: () => edition,
    personalAccount: () => personalAccount,
    projectAccount: () => projectAccount,
    binding: async (workspace) => {
      const active = await current(),
        mapped = options.mappings.find((m) =>
          [m.localWorkspaceId, m.cloudWorkspaceId].includes(workspace),
        )?.cloudWorkspaceId;
      if (!active || !mapped || !active.activeWorkspaces.has(mapped)) return null;
      const bound = await account.binding(workspace),
        after = await current();
      return after?.userId === active.userId &&
        after.version === active.version &&
        after.activeWorkspaces.has(mapped)
        ? bound
        : null;
    },
    signOut: invalidate,
  };
  return {
    account: securedAccount,
    edition,
    personalAccount,
    plugin,
    signOut: invalidate,
  };
}
