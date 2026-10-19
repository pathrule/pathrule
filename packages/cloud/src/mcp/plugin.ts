// SPDX-License-Identifier: Apache-2.0
// Pathrule Cloud as a plugin of the open MCP server (@pathrule/mcp): the account edition. The
// compositions with Pathrule Cloud (the CLI's `pathrule mcp run`, the VS Code extension's server)
// install it; the server runs on the local store without it.

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { MCP_PACKAGE } from "@pathrule/mcp/package-instance.js";
import type { McpPlugin } from "@pathrule/mcp/plugin.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import type { NativeAccount } from "../native/account.js";
import { scheduleDeliveryReports } from "../native/delivery-reporter.js";
import { nativeCloudRuntime, nativeRequest } from "../native/runtime.js";
import { observeToolForTelemetry } from "./tool-telemetry.js";

/**
 * The plugin the compositions with Pathrule Cloud pass to `startPathruleMcpServer`. A native account the
 * composition opted into binds the person of each mapped local workspace. Without one, the account
 * is Pathrule Cloud's (../native/runtime.ts): the open server's tools serve the folders the person
 * attached, through the Cloud's Project backend, and their person binding. A build or run that
 * names no Pathrule Cloud (../native/config.ts) has no account: the open server alone.
 */
export function cloudMcpPlugin(
  options: { native?: NativeAccount; env?: NodeJS.ProcessEnv } = {},
): McpPlugin {
  const env = options.env ?? process.env;
  const shared = [MCP_PACKAGE, CORE_PACKAGE, INTEGRATIONS_PACKAGE];
  if (options.native) {
    const project = options.native.projectAccount();
    return {
      name: "cloud",
      contract: MCP_PLUGIN_CONTRACT,
      sharedPackages: shared,
      tools: [],
      toolCompleted: (event) => void observeToolForTelemetry(event),
      personalAccount: options.native.personalAccount(),
      ...(project ? { projectAccount: project } : {}),
    };
  }
  const runtime = nativeCloudRuntime({ env });
  if (!runtime) {
    return {
      name: "cloud",
      contract: MCP_PLUGIN_CONTRACT,
      sharedPackages: shared,
      tools: [],
      toolCompleted: (event) => void observeToolForTelemetry(event),
    };
  }
  // After tool calls, at most every few minutes: what this machine's sessions received from the
  // attached Cloud workspaces goes to the Cloud as daily counts (../native/delivery-reporter.ts).
  const reportDeliveries = () =>
    scheduleDeliveryReports(async () => {
      const person = await runtime.person();
      const signedIn = person ? await nativeRequest(runtime) : null;
      if (!person || !signedIn) return null;
      return {
        request: signedIn.request,
        workspaceIds: person.workspaces.map((entry) => entry.workspace_id),
      };
    }, env);
  return {
    name: "cloud",
    contract: MCP_PLUGIN_CONTRACT,
    sharedPackages: shared,
    tools: [],
    toolCompleted: (event) => {
      void observeToolForTelemetry(event);
      reportDeliveries();
    },
    personalAccount: runtime.personalAccount,
    projectAccount: runtime.projectAccount,
  };
}
