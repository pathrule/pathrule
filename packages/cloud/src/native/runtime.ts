// SPDX-License-Identifier: Apache-2.0
// Pathrule Cloud, the native backend, as the CLI, its MCP server, its host and VS Code use it when
// the build or the run names it (./config.ts). It composes the native account (./composition.ts)
// from the session on this machine (./credentials.ts) and the folders the person attached
// (./workspaces.ts), and builds it again when either changes, so an `attach` or a `login` reaches
// a host that is already running. The session is extended on the way when it is close to expiry.
import type { HostAccountEdition, HostPlugin } from "@pathrule/host/plugin.js";
import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import type { McpPersonalAccount, McpProjectAccount } from "@pathrule/mcp/plugin.js";
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { NativeResolvedBackend } from "./account.js";
import { cloudHttp, type CloudTransport } from "./client/http.js";
import { createNativeCloudComposition } from "./composition.js";
import { nativeCloudConfig } from "./config.js";
import {
  nativeSessionNeedsRefresh,
  nativeTransportSource,
  readNativeSession,
  refreshNativeSession,
  type NativeSessionDeps,
} from "./credentials.js";
import { nativeMappings, readNativeWorkspaces, type NativeWorkspaceEntry } from "./workspaces.js";

type Composition = ReturnType<typeof createNativeCloudComposition>;

/** How often a long-running process asks the server to extend a session close to its expiry. */
const REFRESH_CHECK_MS = 10 * 60_000;

export interface NativeCloudRuntime {
  /** The host's account edition. */
  edition: HostAccountEdition<NativeResolvedBackend>;
  /** The MCP server's person binding. */
  personalAccount: McpPersonalAccount;
  /** The MCP server's Project knowledge of attached folders. */
  projectAccount: McpProjectAccount;
  /** The host plugin that provides the edition. */
  hostPlugin(): HostPlugin;
  /** A transport for the session on this machine, or null when nobody is signed in. */
  transport(): Promise<CloudTransport | null>;
  /** The signed-in person's id and attached folders, or null when nobody is signed in. */
  person(): Promise<{ userId: string; workspaces: NativeWorkspaceEntry[] } | null>;
  /** Drops what this process holds for the session: published private fields and the owner record. */
  signOut(): Promise<void>;
}

/**
 * No folder is attached here: the MCP server and the host cannot tell the person, so only the CLI
 * restores a folder's binding (./auto-attach.ts), on a line of its own.
 */
export interface NativeCloudRuntimeOptions extends NativeSessionDeps {
  env: NodeJS.ProcessEnv;
}

/** The native runtime of this build or run, or null when it names no Pathrule Cloud. */
export function nativeCloudRuntime(options: NativeCloudRuntimeOptions): NativeCloudRuntime | null {
  if (!nativeCloudConfig(options.env)) return null;
  return createNativeCloudRuntime(options);
}

export function createNativeCloudRuntime(options: NativeCloudRuntimeOptions): NativeCloudRuntime {
  const deps: NativeSessionDeps = { ...options, env: options.env };
  // The hook ranks a prompt over the Cloud's index at the Cloud this build or run names.
  const semanticUrl = nativeCloudConfig(options.env)?.baseUrl;
  const transport = nativeTransportSource(deps);
  let built: { key: string; composition: Composition } | null = null;
  let refreshedAt = 0;

  async function person() {
    const session = await readNativeSession(deps).catch(() => null);
    if (!session) return null;
    return {
      userId: session.user_id,
      workspaces: await readNativeWorkspaces(session.user_id, options.env),
    };
  }

  async function extendSession(): Promise<void> {
    const now = (options.now ?? (() => new Date()))();
    if (now.getTime() - refreshedAt < REFRESH_CHECK_MS) return;
    refreshedAt = now.getTime();
    const session = await readNativeSession(deps).catch(() => null);
    if (session && nativeSessionNeedsRefresh(session, now)) await refreshNativeSession(deps);
  }

  async function composition(): Promise<Composition> {
    await extendSession().catch(() => {});
    const current = await person();
    const key = JSON.stringify([current?.userId ?? null, current?.workspaces ?? []]);
    if (built?.key !== key) {
      // The earlier composition is dropped, not signed out: a new attachment is not a sign-out, and
      // the new composition checks the session again before it trusts anything.
      built = {
        key,
        composition: createNativeCloudComposition({
          transport,
          mappings: nativeMappings(current?.workspaces ?? []),
          env: options.env,
          serveProjectBackend: true,
        }),
      };
    }
    return built.composition;
  }

  const edition: HostAccountEdition<NativeResolvedBackend> = {
    resolveBackend: async (cwd) => (await composition()).edition.resolveBackend(cwd),
    identity: async () => (await composition()).edition.identity(),
    personal: async (input) => (await composition()).edition.personal?.(input) ?? null,
    turnContext: {
      // Synchronous: the composition that resolved this turn's backend is the one built.
      sessionKey: (resolved, workspaceId) =>
        built?.composition.edition.turnContext.sessionKey(resolved, workspaceId) ?? null,
      sections: async (input) => (await composition()).edition.turnContext.sections(input),
      afterRender: async (input) => (await composition()).edition.turnContext.afterRender(input),
    },
  };

  const personalAccount: McpPersonalAccount = {
    async bind(workspaceId) {
      try {
        return await (await composition()).personalAccount.bind(workspaceId);
      } catch {
        return null;
      }
    },
  };

  const projectAccount: McpProjectAccount = {
    resolveContext: async (input) =>
      (await (await composition()).account.projectAccount()?.resolveContext(input)) ?? null,
    semanticEndpoint: () => (semanticUrl ? { url: semanticUrl, native: true } : null),
  };

  return {
    edition,
    personalAccount,
    projectAccount,
    hostPlugin: () => ({
      name: "cloud",
      contract: HOST_PLUGIN_CONTRACT,
      sharedPackages: [CORE_PACKAGE, INTEGRATIONS_PACKAGE],
      activate(ctx) {
        ctx.provideAccount(edition);
      },
    }),
    transport: async () => {
      await extendSession().catch(() => {});
      return transport();
    },
    person,
    async signOut() {
      await built?.composition.signOut();
      built = null;
    },
  };
}

/**
 * The person's requests on the native Cloud, pinned to them (`x-native-owner`), or null when nobody
 * is signed in. For the account commands, which name their workspace or organization themselves.
 */
export async function nativeRequest(runtime: NativeCloudRuntime) {
  const transport = await runtime.transport();
  if (!transport) return null;
  const request = cloudHttp(transport);
  const { userId } = await request<{ userId: string }>("/v1/me/identity");
  if (typeof userId !== "string" || !userId)
    throw new Error("Native authenticated identity required");
  return {
    userId,
    request: cloudHttp({
      ...transport,
      headers: async () => ({ ...(await transport.headers()), "x-native-owner": userId }),
    }),
  };
}
