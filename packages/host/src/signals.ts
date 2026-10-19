// SPDX-License-Identifier: Apache-2.0
/**
 * `signals.ingest`: an application's runtime events, sent by the Signals SDK's local destination
 * (`@pathrule/signals/local`). The host finds the workspace that covers the application's folder,
 * never a mirror of a hosted workspace, and hands the envelope to that store, which reads it the
 * way every collector does. The size the store checks is the host's own measure, not the
 * client's.
 *
 * The RPC server already refuses a browser (any `Origin`), a foreign `Host` and a missing token,
 * so a web page cannot write here; only a process of this user that can read the host's record.
 */
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";

import type { RuntimeIngestResult } from "@pathrule/protocol/runtime-events.js";

import { HostRpcFailure } from "./methods.js";
import { StoresClosedError, type WorkspaceStores } from "./stores.js";
import { resolveWorkspaceIdentity } from "./workspace.js";

export interface SignalsIngestParams {
  cwd: string;
  envelope: unknown;
}

export function parseSignalsIngestParams(params: unknown): SignalsIngestParams {
  const value = (params ?? {}) as { cwd?: unknown; envelope?: unknown };
  if (typeof value !== "object" || typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw new HostRpcFailure("invalid_params", "signals.ingest needs an absolute cwd");
  }
  if (value.envelope === undefined) {
    throw new HostRpcFailure("invalid_params", "signals.ingest needs an envelope");
  }
  return { cwd: value.cwd, envelope: value.envelope };
}

export async function ingestSignals(
  params: unknown,
  env: NodeJS.ProcessEnv,
  stores: WorkspaceStores,
): Promise<RuntimeIngestResult> {
  const { cwd, envelope } = parseSignalsIngestParams(params);
  const identity = resolveWorkspaceIdentity(cwd, env, { includeMirrors: false });
  if (!identity) throw new HostRpcFailure("not_found", "no Pathrule workspace covers this folder");
  const bytes = Buffer.byteLength(JSON.stringify(envelope) ?? "", "utf8");
  let store;
  try {
    store = stores.get(identity.workspaceId);
  } catch (err) {
    if (err instanceof StoresClosedError) throw new HostRpcFailure("shutting_down", err.message);
    throw err;
  }
  const result = await store.ingestRuntimeEvents(identity.workspaceId, envelope, { bytes });
  if (result.status === "accepted") {
    await writeIndicatorSnapshot(
      env,
      identity.workspaceId,
      await store.runtimeIndicatorSnapshot(identity.workspaceId),
    );
  }
  return result;
}

/**
 * The agent hook reads files only, so the host leaves it the current error groups per path (counts,
 * no application text) next to the hook index. Best effort: a failed write costs the hook its line.
 */
async function writeIndicatorSnapshot(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  snapshot: unknown,
): Promise<void> {
  try {
    const dir = join(pathruleHome(env), "cache", workspaceId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, "runtime-indicator.json");
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch {
    // The hook goes without the line.
  }
}
