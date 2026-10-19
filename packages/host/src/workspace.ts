// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace identity: which local store serves a folder. The rule is core's, unchanged
 * (`LocalBackend.discoverWorkspaceForCwd`): the longest matching root wins, a worktree binding
 * counts as a root, and a mirror of a hosted workspace counts only when the caller asks for it.
 */
import { isAbsolute } from "node:path";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import type {
  HostLocalWorkspaceSummary,
  HostWorkspaceIdentity,
} from "@pathrule/protocol/host-rpc.js";

import { HostRpcFailure } from "./methods.js";

/**
 * Every local workspace of the home (`workspace.list`): core's read-only scan, which opens each
 * store read-only and never for writing, and leaves mirrors of hosted workspaces out.
 */
export function listLocalWorkspaces(env: NodeJS.ProcessEnv): HostLocalWorkspaceSummary[] {
  return LocalBackend.listLocalWorkspaces(env).map((workspace) => ({
    id: workspace.workspaceId,
    name: workspace.name,
    rootPath: workspace.localRootPath,
  }));
}

/** The params of `workspace.list`: nothing, or `includeMirrors: false`. Mirrors are never listed. */
export function parseListParams(params: unknown): void {
  const value = (params ?? {}) as { includeMirrors?: unknown };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HostRpcFailure("invalid_params", "workspace.list takes an object");
  }
  if (value.includeMirrors !== undefined && value.includeMirrors !== false) {
    throw new HostRpcFailure("invalid_params", "workspace.list never lists mirrors");
  }
}

export function resolveWorkspaceIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { includeMirrors?: boolean } = {},
): HostWorkspaceIdentity | null {
  const match = LocalBackend.discoverWorkspaceForCwd(cwd, env, {
    includeMirrors: options.includeMirrors === true,
  });
  if (!match) return null;
  return {
    workspaceId: match.workspaceId,
    root: match.localRootPath,
    relativePath: match.relativePath,
    mirror: LocalBackend.isMirror(match.workspaceId, env),
  };
}

/** The params of `workspace.resolve`: an absolute `cwd`, and an optional boolean `includeMirrors`. */
export function parseResolveParams(params: unknown): { cwd: string; includeMirrors: boolean } {
  const value = (params ?? {}) as { cwd?: unknown; includeMirrors?: unknown };
  if (typeof value !== "object" || typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw new HostRpcFailure("invalid_params", "workspace.resolve needs an absolute cwd");
  }
  if (value.includeMirrors !== undefined && typeof value.includeMirrors !== "boolean") {
    throw new HostRpcFailure("invalid_params", "includeMirrors must be a boolean");
  }
  return { cwd: value.cwd, includeMirrors: value.includeMirrors === true };
}
