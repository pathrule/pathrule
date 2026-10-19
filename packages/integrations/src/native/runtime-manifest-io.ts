// SPDX-License-Identifier: Apache-2.0
// Read and write the runtime manifest (protocol/runtime-manifest.ts). The runtime that installs the
// canonical hook writes it; launchers and doctors read it.

import { readFile } from "node:fs/promises";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import {
  LAUNCHER_CONTRACT,
  RUNTIME_CLI_ENV_ALLOWLIST,
  RUNTIME_MANIFEST_SCHEMA,
  parseRuntimeManifest,
  sanitizeRuntimeLaunchEnv,
  type RuntimeLaunch,
  type RuntimeManifest,
} from "@pathrule/protocol/runtime-manifest.js";

import { runtimeManifestPath } from "./home.js";

export async function readRuntimeManifest(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeManifest | null> {
  try {
    return parseRuntimeManifest(JSON.parse(await readFile(runtimeManifestPath(env), "utf8")));
  } catch {
    return null;
  }
}

export interface RuntimeManifestInput {
  runtimeVersion: string;
  hookExtensionContract: number;
  hookIndexSchemas: number[];
  hookPath: string;
  cli: { node: string; entry: string; env?: Record<string, string> };
  /** The MCP server every native plugin launches; it names no edition. Undefined keeps the recorded one. */
  mcp?: RuntimeLaunch;
  /** Undefined keeps what the manifest already records. */
  maintenanceConsent?: boolean;
  now?: Date;
}

/**
 * An older runtime's launch named Local (`PATHRULE_LOCAL`), which nothing reads any more: the launch
 * names no edition, and the server resolves each call's folder.
 */
function editionNeutral(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== "PATHRULE_LOCAL"));
}

/**
 * Write the manifest for the runtime this process is. The maintenance consent and the MCP launch are
 * kept from an existing manifest unless the caller decides them: a plain `pathrule sync` must not
 * revoke the consent a setup recorded. The manifest records no machine-wide mode: an older one's is
 * dropped, since each project is served from its own edition.
 */
export async function writeRuntimeManifest(
  input: RuntimeManifestInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeManifest> {
  const previous = await readRuntimeManifest(env);
  const now = (input.now ?? new Date()).toISOString();
  const consent = input.maintenanceConsent ?? previous?.maintenance.consent ?? false;
  const mcp = input.mcp ?? previous?.mcp;
  const manifest: RuntimeManifest = {
    schema_version: RUNTIME_MANIFEST_SCHEMA,
    launcher_contract: LAUNCHER_CONTRACT,
    runtime_version: input.runtimeVersion,
    hook_extension_contract: input.hookExtensionContract,
    hook_index_schemas: [...input.hookIndexSchemas].sort((a, b) => a - b),
    hook: input.hookPath,
    cli: {
      node: input.cli.node,
      entry: input.cli.entry,
      ...(input.cli.env ? { env: sanitizeRuntimeLaunchEnv(input.cli.env, RUNTIME_CLI_ENV_ALLOWLIST) } : {}),
    },
    ...(mcp
      ? { mcp: { command: mcp.command, args: [...mcp.args], env: editionNeutral(sanitizeRuntimeLaunchEnv(mcp.env)) } }
      : {}),
    maintenance: consent
      ? {
          consent: true,
          recorded_at:
            input.maintenanceConsent === true || !previous?.maintenance.recorded_at
              ? now
              : previous.maintenance.recorded_at,
        }
      : { consent: false },
    written_at: now,
  };
  await atomicWrite(runtimeManifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return manifest;
}
