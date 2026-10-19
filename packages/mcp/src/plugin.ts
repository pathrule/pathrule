// SPDX-License-Identifier: Apache-2.0
/**
 * What the MCP server asks of its plugins. The server is open and serves the local store on its
 * own; a plugin adds tools, and at most one adds an account (Project knowledge, the person). A composition root (the CLI,
 * a packaged server) passes its plugins to `startPathruleMcpServer`, which installs them
 * here before the first tool runs. Every call site names its open default, which is what the
 * server does with no plugin installed and what local mode does with one.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PersonalStoreBinding } from "@pathrule/core/engine/contracts.js";
import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { assertSharedPackages, type PackageInstance } from "@pathrule/protocol/package-instance.js";
// The contract version lives only in `protocol`: a plugin must read it from its own copy, never
// through this module, which would hand it the server's number.
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import type {
  IntelligenceProfileDelivery,
  IntelligenceSurface,
} from "@pathrule/protocol/intelligence-delivery.js";

import { MCP_PACKAGE } from "./package-instance.js";
import type { ToolDef } from "./tools/types.js";

/** The shared packages, as this server resolved them. A plugin must have resolved the same copies. */
export const MCP_SHARED_PACKAGES: readonly PackageInstance[] = [
  MCP_PACKAGE,
  CORE_PACKAGE,
  INTEGRATIONS_PACKAGE,
];

export interface McpPlugin {
  readonly name: string;
  /**
   * The `MCP_PLUGIN_CONTRACT` the plugin was built against: imported from
   * `@pathrule/protocol/plugin-contracts.js`, the plugin's own copy.
   */
  readonly contract: number;
  /**
   * The copy of each shared package the plugin imports: the `*_PACKAGE` token of every package it
   * uses among mcp, core and integrations, as the plugin resolved it. The server refuses a plugin
   * that resolved another copy than its own.
   */
  readonly sharedPackages: readonly PackageInstance[];
  /**
   * Tools this plugin adds. Each takes its place in the advertised order (`TOOL_ORDER`); a name
   * that is not listed there goes last.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools?: readonly ToolDef<any>[];
  /**
   * Tools that need the raw server, registered after the listed ones. Returns how many it
   * advertised.
   */
  registerTools?(server: McpServer, options: { workspaceRoot: string }): Promise<number>;
  /** The person an account binds to a workspace without being the edition. At most one supplies it. */
  readonly personalAccount?: McpPersonalAccount;
  /** An account's Project knowledge for the workspaces it maps. At most one supplies it. */
  readonly projectAccount?: McpProjectAccount;
  /**
   * Observes a finished tool call: its name, whether it answered without an error, and the
   * connected client's id (`resolveClientId`). Called after the answer is built and never awaited:
   * an observer cannot change, delay or fail what a tool returns.
   */
  toolCompleted?(event: { tool: string; ok: boolean; client: string | null }): void;
}

/**
 * An account's Project knowledge, for the workspaces it maps explicitly, served for a folder whose
 * edition is Pathrule Cloud (core workspace/folder-mode.ts) and for no other: a Local folder keeps its
 * local store, and a Cloud folder this account cannot serve fails rather than falling back to one
 * (`resolveOpenContext`). It is not an account edition: a call on a context it returns takes the open default for
 * every account-only step (change log, companion re-render, telemetry), so nothing it cannot do is
 * pretended. The backend is the account's own `KnowledgeBackend`, bound to one authenticated owner.
 */
export interface McpProjectAccount {
  /**
   * The context of the Project mapped to `workspaceId` (either side of a mapping) or to `cwd` (inside
   * a mapping's checkout), or null when it maps none. Throws when the call is mapped but the account
   * cannot serve it (signed out, revoked), so a mapped call never quietly lands somewhere else.
   */
  resolveContext(input: { workspaceId: string | null; cwd: string }): Promise<ToolContext | null>;
  /**
   * The account's semantic ranking endpoint the hook index of one of its Projects carries, so the
   * hook ranks a prompt over the account's index instead of keyword overlap. Absent: none.
   */
  semanticEndpoint?(): { url: string; native: true } | null;
}

/**
 * The signed-in person an account binds to one workspace through an explicit mapping: their id,
 * their belief store and their profiles. It is not an account edition: the workspace's knowledge
 * stays where the server reads it (the local store in local mode), so it serves local mode as well,
 * where a mapping's workspace lives. Every section it feeds is the person's under `userId`, the
 * owner the hook recognises.
 */
export interface McpPersonBinding extends PersonalStoreBinding {
  /**
   * The person's team and personal profiles for this request, as `intelligenceProfiles` of the
   * edition delivers them, owned by `userId`. Null when the provider is unavailable. Never throws.
   */
  intelligenceProfiles(input: {
    userIntent: string;
    surface: IntelligenceSurface;
    exclude?: readonly string[];
    maxChars?: number;
  }): Promise<IntelligenceProfileDelivery | null>;
}

export interface McpPersonalAccount {
  /** The person bound to `workspaceId`, or null when nobody is. Never throws. */
  bind(workspaceId: string): Promise<McpPersonBinding | null>;
}

let installedPlugins: readonly McpPlugin[] = [];

/** Tell every observer a tool finished (`McpPlugin.toolCompleted`). Never throws. */
export function notifyToolCompleted(tool: string, result: unknown, client: string | null): void {
  const ok = !(typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false);
  for (const plugin of installedPlugins) {
    try {
      plugin.toolCompleted?.({ tool, ok, client });
    } catch {
      // An observer's failure is its own.
    }
  }
}

/**
 * Install the plugins of this process. Later calls replace earlier ones. Throws for a plugin built
 * for another contract, a plugin that resolved a second copy of a shared package, and a second
 * Project account or person binding.
 */
export function installMcpPlugins(plugins: readonly McpPlugin[]): void {
  for (const plugin of plugins) {
    if (plugin.contract !== MCP_PLUGIN_CONTRACT) {
      throw new Error(
        `MCP plugin ${plugin.name} was built for contract ${plugin.contract}; this server speaks ${MCP_PLUGIN_CONTRACT}.`,
      );
    }
    assertSharedPackages({
      seam: "MCP",
      plugin: plugin.name,
      host: MCP_SHARED_PACKAGES,
      resolved: plugin.sharedPackages,
    });
  }
  const projects = plugins.filter((p) => p.projectAccount);
  if (projects.length > 1) {
    throw new Error(
      `At most one MCP plugin may serve Project knowledge; got ${projects.map((p) => p.name).join(", ")}.`,
    );
  }
  const people = plugins.filter((p) => p.personalAccount);
  if (people.length > 1) {
    throw new Error(
      `At most one MCP plugin may bind the person; got ${people.map((p) => p.name).join(", ")}.`,
    );
  }
  installedPlugins = [...plugins];
}

/** The installed Project account, or null: no Cloud folder can be served. */
export function mcpProjectAccount(): McpProjectAccount | null {
  return installedPlugins.find((p) => p.projectAccount)?.projectAccount ?? null;
}

/** The installed person binding, or null: the no-account person's local file. */
export function mcpPersonalAccount(): McpPersonalAccount | null {
  return installedPlugins.find((p) => p.personalAccount)?.personalAccount ?? null;
}
