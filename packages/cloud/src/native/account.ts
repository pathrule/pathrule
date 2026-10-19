// SPDX-License-Identifier: Apache-2.0
// A native Pathrule Cloud account bound to local workspaces through explicit mappings. Opt-in: a
// composition passes it to `cloudCliPlugin({ native })` (the CLI's host and MCP server); without one
// the account is Pathrule Cloud's own session on this machine (./runtime.ts).
//
// It binds the person first. For a mapped local workspace the host's turn, MCP get_context and the
// hook index read the person's guidance from their account's belief store and their team and personal
// profiles from their account's provider, all under the one owner the provider authenticated. The
// provider's Project backend (`knowledge`, a full `KnowledgeBackend`) serves a mapped folder only
// when the composition asks for it (`serveProjectBackend`) and only where no local store does: to the
// host as a resolved backend, and to the MCP server as the context of a mapped workspace
// (`projectAccount`, local mode). Off by default; nothing here fills an operation the backend lacks.
//
// The provider (the Cloud service's `resolveCloudNativeBinding` over a native transport) authenticates the
// owner and pins it; this module never takes an owner from a caller. Every binding it resolves
// records its owner as the signed-in `native` account (core storage/account-owners.ts), which is how
// the hook recognises the person. Another owner replaces the record and drops the previous owner's
// bindings; a provider with nobody signed in clears it; `signOut` clears both. An unreachable provider
// is not a sign-out: the turn falls back to the local defaults and the record stays.

import type { KnowledgeBackend } from "@pathrule/core";
import {
  clearAccountOwner,
  readAccountOwners,
  recordAccountOwner,
} from "@pathrule/core/storage/account-owners.js";
import type { UserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";
import type { ResolvedTurnBackend } from "@pathrule/host/context/compile.js";
import type { HostAccountEdition } from "@pathrule/host/plugin.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { forgetPersonalFieldsOf } from "@pathrule/integrations/index-writers/personal-index-refresh.js";
import type { McpPersonalAccount, McpProjectAccount } from "@pathrule/mcp/plugin.js";
import { intelligenceSurface } from "@pathrule/protocol/intelligence-delivery.js";

import {
  deliverIntelligenceProfiles,
  type IntelligenceProfileSource,
} from "../intelligence/profile-context.js";
import { NATIVE_ACCOUNT_PROVIDER } from "./owner.js";

/** The provider name the owner record and the hook know this account by. */
export { NATIVE_ACCOUNT_PROVIDER };
/** How long a resolved binding is reused before the provider is asked again. */
export const NATIVE_BINDING_TTL_MS = 5 * 60_000;
/** How long a provider failure is remembered, so a turn does not wait on it again. */
export const NATIVE_BINDING_RETRY_MS = 30_000;

/** One local workspace bound to one native cloud workspace, named by the person, never guessed. */
export interface NativeWorkspaceMapping {
  localWorkspaceId: string;
  cloudWorkspaceId: string;
  cloudOrganizationId?: string;
  /** The checkout; a folder inside it is served by `knowledge` when the composition opts in. */
  localRootPath?: string;
  runtimeId?: string;
}

/** What the provider binds for one mapping: one authenticated owner, pinned on every request. */
export interface NativeAccountBinding {
  userId: string;
  /** The cloud workspace; it must be the mapping's. */
  workspaceId: string;
  mapping: NativeWorkspaceMapping;
  userKnowledgeStore: UserKnowledgeStore;
  profileSource: IntelligenceProfileSource;
  /** The cloud workspace's project backend; used only with `serveProjectBackend`. */
  knowledge?: KnowledgeBackend;
}

export interface NativeAccountProvider {
  /**
   * The binding of one mapping, or null when nobody is signed in. Throws when the provider cannot be
   * reached or refuses the mapping (another workspace, another organization, a revoked session).
   */
  resolveBinding(mapping: NativeWorkspaceMapping): Promise<NativeAccountBinding | null>;
}

/** A folder the native account serves carries the mapping that served it. */
export interface NativeResolvedBackend extends ResolvedTurnBackend {
  mapping?: NativeWorkspaceMapping;
}

export interface NativeAccount {
  /**
   * The person bound to a mapped workspace, named by either side of its mapping; null when unmapped,
   * signed out or failing. Never throws.
   */
  binding(workspaceId: string): Promise<NativeAccountBinding | null>;
  /** The host's account edition (`HostPluginContext.provideAccount`). */
  edition(): HostAccountEdition<NativeResolvedBackend>;
  /** The MCP server's person binding (`McpPlugin.personalAccount`). */
  personalAccount(): McpPersonalAccount;
  /**
   * The MCP server's Project knowledge for mapped workspaces (`McpPlugin.projectAccount`): the
   * provider's backend, bound to its authenticated owner. Only with `serveProjectBackend`; absent
   * otherwise, so the server keeps its local-only behavior.
   */
  projectAccount(): McpProjectAccount | null;
  /** Forgets every binding and the recorded owner. */
  signOut(): Promise<void>;
}

export interface NativeAccountOptions {
  provider: NativeAccountProvider;
  mappings: readonly NativeWorkspaceMapping[];
  /** Serve a mapped folder no local store serves from the provider's project backend. Default off. */
  serveProjectBackend?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  now?: () => number;
}

interface CacheEntry {
  expires: number;
  value: Promise<NativeAccountBinding | null>;
}

function validMappings(mappings: readonly NativeWorkspaceMapping[]): NativeWorkspaceMapping[] {
  const seen = new Set<string>();
  return mappings.map((mapping) => {
    if (!mapping.localWorkspaceId || !mapping.cloudWorkspaceId) {
      throw new Error("a native workspace mapping names both workspaces");
    }
    if (seen.has(mapping.localWorkspaceId)) {
      throw new Error(`local workspace ${mapping.localWorkspaceId} is mapped twice`);
    }
    seen.add(mapping.localWorkspaceId);
    return Object.freeze({ ...mapping });
  });
}

function inside(cwd: string, root: string): boolean {
  const base = root.replace(/\/+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

export function createNativeAccount(options: NativeAccountOptions): NativeAccount {
  const mappings = validMappings(options.mappings);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  // The owner this process's bindings belong to; another owner drops the others.
  let owner: string | null = null;
  // A sign-out outdates every resolution still in flight.
  let generation = 0;

  function dropOthers(key: string): void {
    for (const other of [...cache.keys()]) if (other !== key) cache.delete(other);
  }

  // A person who leaves (signs out, is switched away from, is revoked) leaves no private entry on
  // this machine's hook indexes; the hook already withholds them once the owner record is gone.
  async function forget(previous: string | null): Promise<void> {
    if (previous) await forgetPersonalFieldsOf([previous], env).catch(() => 0);
  }

  async function resolve(
    mapping: NativeWorkspaceMapping,
    key: string,
  ): Promise<NativeAccountBinding | null> {
    const started = generation;
    const bound = await options.provider.resolveBinding(mapping);
    if (started !== generation) return null;
    if (!bound) {
      // Nobody is signed in: nothing of the previous owner is delivered any more.
      const previous = owner;
      owner = null;
      dropOthers(key);
      const cleared = await clearAccountOwner(NATIVE_ACCOUNT_PROVIDER, env).catch(
        () => [] as string[],
      );
      for (const gone of new Set([previous, ...cleared])) await forget(gone);
      return null;
    }
    if (typeof bound.userId !== "string" || bound.userId === "") {
      throw new Error("the native provider bound no owner");
    }
    if (bound.workspaceId !== mapping.cloudWorkspaceId) {
      throw new Error("the native provider bound another workspace than the mapping");
    }
    if (owner !== bound.userId) {
      // An account switch: the previous owner's bindings go, this one is the recorded owner.
      if (owner !== null) dropOthers(key);
      owner = bound.userId;
    }
    const replaced = await recordAccountOwner(NATIVE_ACCOUNT_PROVIDER, bound.userId, env).catch(
      () => null,
    );
    if (replaced !== null && replaced !== bound.userId) await forget(replaced);
    return bound;
  }

  function bindingOf(mapping: NativeWorkspaceMapping): Promise<NativeAccountBinding | null> {
    const key = mapping.localWorkspaceId;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    const entry: CacheEntry = {
      expires: now() + NATIVE_BINDING_TTL_MS,
      value: Promise.resolve(null),
    };
    // Nobody signed in, or a provider that failed, is asked again sooner than a binding.
    const retrySoon = () => {
      entry.expires = now() + NATIVE_BINDING_RETRY_MS;
      return null;
    };
    entry.value = resolve(mapping, key).then((bound) => bound ?? retrySoon(), retrySoon);
    cache.set(key, entry);
    return entry.value;
  }

  /** The mapping a workspace id names, from either side: a Project context carries the cloud id. */
  function mappingOf(workspaceId: string): NativeWorkspaceMapping | undefined {
    return (
      mappings.find((m) => m.localWorkspaceId === workspaceId) ??
      mappings.find((m) => m.cloudWorkspaceId === workspaceId)
    );
  }

  /** The mapping whose checkout holds `cwd`, the deepest one when checkouts nest. */
  function mappingAt(cwd: string): NativeWorkspaceMapping | undefined {
    return mappings
      .filter((m) => m.localRootPath && inside(cwd, m.localRootPath))
      .sort((a, b) => b.localRootPath!.length - a.localRootPath!.length)[0];
  }

  async function binding(workspaceId: string): Promise<NativeAccountBinding | null> {
    const mapping = mappingOf(workspaceId);
    return mapping ? bindingOf(mapping) : null;
  }

  /** The binding of a turn: the mapping that served the folder, else the local workspace's. */
  function turnBinding(resolved: NativeResolvedBackend, workspaceId: string) {
    return resolved.mapping ? bindingOf(resolved.mapping) : binding(workspaceId);
  }

  function edition(): HostAccountEdition<NativeResolvedBackend> {
    return {
      async resolveBackend(cwd) {
        if (!options.serveProjectBackend) return null;
        const mapping = mappingAt(cwd);
        if (!mapping) return null;
        const bound = await bindingOf(mapping);
        return bound?.knowledge ? { backend: bound.knowledge, kind: "cloud", mapping } : null;
      },
      async identity() {
        const recorded = (await readAccountOwners(env))[NATIVE_ACCOUNT_PROVIDER]?.user_id;
        return recorded ? `${NATIVE_ACCOUNT_PROVIDER}:${recorded}` : "signed-out";
      },
      turnContext: {
        // This account keeps no affinity loop or retrieval signals of its own.
        sessionKey: () => null,
        async sections({ resolved, workspaceId, userIntent, surface }) {
          const bound = await turnBinding(resolved, workspaceId);
          const profiles = bound
            ? await deliverIntelligenceProfiles(bound.profileSource, {
                owner: bound.userId,
                workspaceId: bound.workspaceId,
                userIntent: userIntent ?? "",
                surface: intelligenceSurface(surface),
              })
            : null;
          return {
            retrieval: { delta: "", version: "" },
            intelligenceBlock: profiles?.block ?? "",
          };
        },
        async afterRender() {},
      },
      async personal({ resolved, workspaceId }) {
        const bound = await turnBinding(resolved, workspaceId);
        return bound ? { userId: bound.userId, userKnowledge: bound.userKnowledgeStore } : null;
      },
    };
  }

  function personalAccount(): McpPersonalAccount {
    return {
      async bind(workspaceId) {
        const bound = await binding(workspaceId);
        if (!bound) return null;
        return {
          userId: bound.userId,
          userKnowledge: bound.userKnowledgeStore,
          intelligenceProfiles: (input) =>
            deliverIntelligenceProfiles(bound.profileSource, {
              ...input,
              owner: bound.userId,
              workspaceId: bound.workspaceId,
            }),
        };
      },
    };
  }

  function projectAccount(): McpProjectAccount | null {
    if (!options.serveProjectBackend) return null;
    return {
      async resolveContext({ workspaceId, cwd }) {
        const mapping = (workspaceId ? mappingOf(workspaceId) : undefined) ?? mappingAt(cwd);
        if (!mapping) return null;
        const bound = await bindingOf(mapping);
        if (!bound?.knowledge) {
          throw new Error(
            `Pathrule Cloud workspace ${mapping.cloudWorkspaceId} is mapped here, but no native session can serve it. Sign in again, or remove the mapping to work locally.`,
          );
        }
        const ctx: ToolContext = {
          backend: bound.knowledge,
          userId: bound.userId,
          workspaceId: bound.workspaceId,
        };
        return ctx;
      },
    };
  }

  return {
    binding,
    edition,
    personalAccount,
    projectAccount,
    async signOut() {
      generation += 1;
      const previous = owner;
      owner = null;
      cache.clear();
      const cleared = await clearAccountOwner(NATIVE_ACCOUNT_PROVIDER, env);
      for (const gone of new Set([previous, ...cleared])) await forget(gone);
    },
  };
}
