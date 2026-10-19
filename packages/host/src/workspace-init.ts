// SPDX-License-Identifier: Apache-2.0
/**
 * `workspace.init`: the local workspace for a folder. A folder already inside a local workspace reuses
 * it. A new one gets an id, its store at `<Pathrule home>/<id>/pathrule.db`, the folder as its root,
 * and a first hook index, so path context reaches the agent from its first prompt.
 *
 * The first index carries no preference or guidance lines; the next sync writes the person's
 * entries.
 */
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";
import type { HostLocalWorkspace } from "@pathrule/protocol/host-rpc.js";

import { HostRpcFailure } from "./methods.js";
import type { WorkspaceStores } from "./stores.js";

export interface WorkspaceInitDependencies {
  env: NodeJS.ProcessEnv;
  stores: WorkspaceStores;
  log(line: string): void;
  /** Defaults to a random UUID. */
  newWorkspaceId?: () => string;
}

function defaultWorkspaceName(folder: string): string {
  return basename(folder.replace(/\/+$/, "")) || "workspace";
}

/** The params of `workspace.init`: an absolute `folder`, and an optional `name`. */
export function parseInitParams(params: unknown): { folder: string; name?: string } {
  const value = (params ?? {}) as { folder?: unknown; name?: unknown };
  if (typeof value.folder !== "string" || !isAbsolute(value.folder)) {
    throw new HostRpcFailure("invalid_params", "workspace.init needs an absolute folder");
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    throw new HostRpcFailure("invalid_params", "name must be a string");
  }
  return value.name === undefined
    ? { folder: value.folder }
    : { folder: value.folder, name: value.name };
}

export async function initLocalWorkspace(
  input: { folder: string; name?: string },
  deps: WorkspaceInitDependencies,
): Promise<HostLocalWorkspace> {
  const folder = input.folder.replace(/\/+$/, "");
  const existing = LocalBackend.discoverWorkspaceForCwd(folder, deps.env);
  if (existing) {
    return {
      workspaceId: existing.workspaceId,
      name: input.name ?? defaultWorkspaceName(existing.localRootPath),
      localRootPath: existing.localRootPath,
      action: "exists",
    };
  }

  const workspaceId = (deps.newWorkspaceId ?? randomUUID)();
  const name = input.name ?? defaultWorkspaceName(folder);
  const backend = deps.stores.get(workspaceId);
  backend.registerWorkspace({ workspaceId, name, localRootPath: folder });

  // Best-effort, never silent: the workspace exists either way, and a missing first index only
  // means the first prompts carry no path context until the next sync.
  try {
    const result = await syncHookIndex({
      backend,
      workspaceId,
      workspaceRoot: folder,
      env: deps.env,
    });
    if (!result.ok) {
      deps.log(
        `hook index warm-up failed for ${workspaceId}: ${result.error ?? "no payload returned"}`,
      );
    }
  } catch (err) {
    deps.log(
      `hook index warm-up threw for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { workspaceId, name, localRootPath: folder, action: "created" };
}
