// SPDX-License-Identifier: Apache-2.0
// Who delivers Pathrule's hook for a workspace: a provider's native plugin, or Pathrule's own
// settings entries. A writer of settings entries asks here first, so a sync never re-adds the
// legacy hook a plugin replaced (the plugin and the entry would both run).

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { integrationFor, type IntegrationProviderId } from "@pathrule/protocol/integration-registry.js";

import { pathWithin, readIntegrationRegistry } from "./registry-io.js";

// The agents whose hook a sync would otherwise also write into the project (a renderer target).
const NATIVE_PROVIDERS: readonly (IntegrationProviderId & AgentTargetId)[] = ["claude-code", "codex", "cursor"];

/** The providers whose native plugin owns Pathrule's hook for `workspaceRoot`. */
export async function pluginHookProviders(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentTargetId[]> {
  const registry = await readIntegrationRegistry(env);
  const out: AgentTargetId[] = [];
  for (const provider of NATIVE_PROVIDERS) {
    const record = integrationFor(registry, provider, workspaceRoot, pathWithin);
    if (record && record.channel === "native-plugin") out.push(provider);
  }
  return out;
}

export async function pluginOwnsHooks(
  provider: IntegrationProviderId,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await pluginHookProviders(workspaceRoot, env)).some((p) => p === provider);
}
