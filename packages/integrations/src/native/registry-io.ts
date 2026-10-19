// SPDX-License-Identifier: Apache-2.0
// Read and update the integration registry (protocol/integration-registry.ts). Every update runs
// under one cross-process lock, so two installers (a plugin's setup and `pathrule integrations`)
// never drop each other's record.

import { readFile } from "node:fs/promises";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import { withFileLock } from "@pathrule/core/storage/file-lock.js";
import {
  emptyIntegrationRegistry,
  integrationFor,
  parseIntegrationRegistry,
  type IntegrationProviderId,
  type IntegrationRecord,
  type IntegrationRegistry,
} from "@pathrule/protocol/integration-registry.js";
import { pathStartsWith, pathsEqual } from "@pathrule/protocol/path-compare.js";

import { integrationRegistryPath } from "./home.js";

export async function readIntegrationRegistry(env: NodeJS.ProcessEnv = process.env): Promise<IntegrationRegistry> {
  try {
    return parseIntegrationRegistry(JSON.parse(await readFile(integrationRegistryPath(env), "utf8")));
  } catch {
    return emptyIntegrationRegistry();
  }
}

/** Run `update` on the current registry under the registry lock and write what it returns. */
export async function updateIntegrationRegistry(
  update: (registry: IntegrationRegistry) => IntegrationRegistry | Promise<IntegrationRegistry>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationRegistry> {
  const target = integrationRegistryPath(env);
  return withFileLock(`${target}.lock`, async () => {
    const next = await update(await readIntegrationRegistry(env));
    await atomicWrite(target, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  });
}

export async function upsertIntegrationRecord(
  record: IntegrationRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationRegistry> {
  return updateIntegrationRegistry(
    (registry) => ({
      ...registry,
      integrations: [...registry.integrations.filter((r) => r.id !== record.id), record],
    }),
    env,
  );
}

export async function removeIntegrationRecord(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await updateIntegrationRegistry(
    (registry) => ({ ...registry, integrations: registry.integrations.filter((r) => r.id !== id) }),
    env,
  );
}

/** Platform-aware containment: `path` is `root` or below it. */
export function pathWithin(root: string, path: string): boolean {
  return pathsEqual(root, path) || pathStartsWith(path, root);
}

/** The integration serving `cwd` for `provider` on this machine, if any. */
export async function integrationServing(
  provider: IntegrationProviderId,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationRecord | null> {
  return integrationFor(await readIntegrationRegistry(env), provider, cwd, pathWithin);
}
