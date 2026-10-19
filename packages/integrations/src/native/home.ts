// SPDX-License-Identifier: Apache-2.0
// Where the native integration state lives under PATHRULE_HOME. One module, so every reader and
// writer (the CLI, the MCP server, a plugin's setup through the CLI) agrees on the paths.

import { createHash } from "node:crypto";
import { join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { INTEGRATION_REGISTRY_DIR, INTEGRATION_REGISTRY_FILE } from "@pathrule/protocol/integration-registry.js";
import { RUNTIME_MANIFEST_FILE } from "@pathrule/protocol/runtime-manifest.js";
import { SESSION_DELIVERY_DIR, isSafeSessionId } from "@pathrule/protocol/session-delivery.js";

export function runtimeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "bin", RUNTIME_MANIFEST_FILE);
}

export function integrationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), INTEGRATION_REGISTRY_DIR);
}

export function integrationRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(integrationsDir(env), INTEGRATION_REGISTRY_FILE);
}

/** A provisioned runtime: `<PATHRULE_HOME>/runtime/<version>/`. */
export function provisionedRuntimeDir(version: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new Error(`invalid_runtime_version:${version}`);
  return join(pathruleHome(env), "runtime", version);
}

/** The file name a session's ledger uses: the id itself when it is file-safe, else its hash. */
export function sessionFileStem(sessionId: string): string {
  return isSafeSessionId(sessionId)
    ? sessionId
    : `h-${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}`;
}

export function deliveryLedgerPath(
  workspaceId: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) {
    throw new Error(`invalid_workspace_id:${workspaceId}`);
  }
  return join(pathruleHome(env), "cache", workspaceId, SESSION_DELIVERY_DIR, `${sessionFileStem(sessionId)}.jsonl`);
}
