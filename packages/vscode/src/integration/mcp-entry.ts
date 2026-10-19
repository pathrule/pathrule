// SPDX-License-Identifier: Apache-2.0
// MCP server entries pointing at the vsix-bundled CLI (plan §5 key decision): the shape of the CLI's
// `resolveMcpServerEntry`, one entry for every folder whatever its edition. The server resolves
// each call's folder, so the entry names no edition and carries no credentials. Two runtimes,
// deliberately:
//  - "electron": spawned BY this extension host (Copilot agent mode):
//    process.execPath + ELECTRON_RUN_AS_NODE=1 is always available.
//  - "node": written into external client configs (claude-code, cursor, …)
//    that spawn outside this host: uses the user's `node` from PATH.
// Env carries only the CLI's passthrough values (PATHRULE_HOME, a Cloud named for this run, proxies).

import { applyPassthroughEnv } from "#cli/install-local.js";
import type { McpServerEntry } from "@pathrule/integrations/mcp-types.js";

export interface McpEntryInput {
  bundledCliPath: string;
  runtime: "electron" | "node";
  /** The extension host's process.execPath (electron runtime only). */
  execPath: string;
  /** The extension host's environment: only the CLI's passthrough keys travel. */
  env: NodeJS.ProcessEnv;
}

export function buildExtensionMcpEntry(input: McpEntryInput): McpServerEntry {
  const entry: McpServerEntry = {
    type: "stdio",
    command: input.runtime === "electron" ? input.execPath : "node",
    args: [input.bundledCliPath, "mcp", "run"],
    env: {},
  };
  applyPassthroughEnv(entry, input.env);
  if (input.runtime === "electron") entry.env!.ELECTRON_RUN_AS_NODE = "1";
  return entry;
}
