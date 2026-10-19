// SPDX-License-Identifier: Apache-2.0
// `context.compile` over the host RPC: the turn context of a folder, compiled with the host's own
// stores, the engine in its slot and the account edition a plugin provided (Pathrule Cloud's). A
// surface without its own compile (the CLI, the local MCP server, an editor) asks the host for the
// same block every surface delivers. A folder resolves to its local store first and to the account second;
// with no account, a folder no local store serves gets the empty context.
import { isAbsolute } from "node:path";

import type { TurnContextRequest } from "@pathrule/protocol/turn-context.js";

import { HostRpcFailure } from "../methods.js";
import type { HostAccountEdition } from "../plugin.js";
import type { WorkspaceStores } from "../stores.js";
import { resolveWorkspaceIdentity } from "../workspace.js";
import type { ResolvedTurnBackend, TurnContextSources } from "./compile.js";

/** More known versions than any conversation holds; the cap only bounds the cache key's work. */
const MAX_KNOWN_ITEM_VERSIONS = 5_000;
const MAX_SURFACE_CHARS = 64;

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HostRpcFailure("invalid_params", `${name} must be a string`);
  }
  return value;
}

export function parseCompileParams(params: unknown): TurnContextRequest {
  const value = (params ?? {}) as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    typeof value.workspaceRoot !== "string" ||
    !isAbsolute(value.workspaceRoot)
  ) {
    throw new HostRpcFailure("invalid_params", "context.compile needs an absolute workspaceRoot");
  }
  const request: TurnContextRequest = { workspaceRoot: value.workspaceRoot };
  if (value.nodePath === null) request.nodePath = null;
  else {
    const nodePath = optionalString(value.nodePath, "nodePath");
    if (nodePath !== undefined) request.nodePath = nodePath;
  }
  const userIntent = optionalString(value.userIntent, "userIntent");
  if (userIntent !== undefined) request.userIntent = userIntent;
  const surface = optionalString(value.surface, "surface");
  if (surface !== undefined) {
    if (surface.length > MAX_SURFACE_CHARS) {
      throw new HostRpcFailure("invalid_params", "surface is too long");
    }
    request.surface = surface;
  }
  const knownStableVersion = optionalString(value.knownStableVersion, "knownStableVersion");
  if (knownStableVersion !== undefined) request.knownStableVersion = knownStableVersion;
  if (value.knownItemVersions !== undefined) {
    const versions = value.knownItemVersions;
    if (
      !Array.isArray(versions) ||
      versions.length > MAX_KNOWN_ITEM_VERSIONS ||
      versions.some((v) => typeof v !== "string")
    ) {
      throw new HostRpcFailure(
        "invalid_params",
        `knownItemVersions must be at most ${MAX_KNOWN_ITEM_VERSIONS} strings`,
      );
    }
    request.knownItemVersions = versions as string[];
  }
  if (value.leaseRequests !== undefined) {
    if (typeof value.leaseRequests !== "boolean") {
      throw new HostRpcFailure("invalid_params", "leaseRequests must be a boolean");
    }
    request.leaseRequests = value.leaseRequests;
  }
  return request;
}

/** The host's own sources: a folder resolves to the local store that serves it, and nothing else. */
export function localTurnSources(
  env: NodeJS.ProcessEnv,
  stores: WorkspaceStores,
): TurnContextSources<ResolvedTurnBackend> {
  return {
    async resolveBackend(cwd) {
      const match = resolveWorkspaceIdentity(cwd, env);
      return match ? { backend: stores.get(match.workspaceId), kind: "local" } : null;
    },
    env,
  };
}

/**
 * The host's sources with the account edition a plugin provided, read on every turn because a plugin
 * provides it after the host built its methods: the local store first, then the account; who is
 * signed in and the account's part of a turn from the account; a cloud workspace's approved atoms from
 * the host's own store of it, which the compile asks for only when it exists.
 */
export function hostTurnSources(
  env: NodeJS.ProcessEnv,
  stores: WorkspaceStores,
  account: () => HostAccountEdition | null,
): TurnContextSources<ResolvedTurnBackend> {
  const local = localTurnSources(env, stores);
  return {
    async resolveBackend(cwd) {
      return (await local.resolveBackend(cwd)) ?? (await account()?.resolveBackend(cwd)) ?? null;
    },
    openLocalStore: async (workspaceId) => stores.get(workspaceId),
    identity: async () => (await account()?.identity()) ?? "signed-out",
    get account() {
      return account()?.turnContext;
    },
    env,
  };
}
