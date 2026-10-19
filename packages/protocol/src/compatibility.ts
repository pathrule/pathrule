// SPDX-License-Identifier: Apache-2.0
/**
 * The contract versions a Pathrule client speaks, under the names the release manifest uses
 * (`release-manifest.ts`: a component's `contracts`, a service's `accepts`).
 *
 * Compatibility is decided by these numbers, never by comparing release versions or content
 * hashes: a Cloud deploy that still accepts every contract a client speaks asks nothing of that
 * client, however much newer it is. Each number moves only when its seam breaks something built
 * against the previous one, and the seam's own module says when.
 */
import { HOOK_EXTENSION_CONTRACT } from "./hook-extension.js";
import { HOST_RPC_VERSION } from "./host-rpc.js";
import {
  CLI_PLUGIN_CONTRACT,
  HOST_PLUGIN_CONTRACT,
  MCP_PLUGIN_CONTRACT,
} from "./plugin-contracts.js";
import { LAUNCHER_CONTRACT } from "./runtime-manifest.js";

/**
 * The MCP tool surface the local and remote servers offer agents: tool names, required arguments
 * and the result fields the hook, the compiled protocol text, skills and native plugins rely on.
 * Bump it when an integration released against the previous surface would break (a tool removed or
 * renamed, a required argument added, a relied-on field dropped). Adding a tool does not bump it.
 */
export const MCP_SURFACE_CONTRACT = 1;

/** The Pathrule Cloud API (`/v1`) a client speaks. */
export const CLOUD_API_CONTRACT = 1;

export type PathruleContractName =
  | "mcp_surface"
  | "cloud_api"
  | "launcher"
  | "host_rpc"
  | "hook_extension"
  | "cli_plugin"
  | "mcp_plugin"
  | "host_plugin";

/** Every contract this build speaks. */
export const PATHRULE_CONTRACTS: Readonly<Record<PathruleContractName, number>> = Object.freeze({
  mcp_surface: MCP_SURFACE_CONTRACT,
  cloud_api: CLOUD_API_CONTRACT,
  launcher: LAUNCHER_CONTRACT,
  host_rpc: HOST_RPC_VERSION,
  hook_extension: HOOK_EXTENSION_CONTRACT,
  cli_plugin: CLI_PLUGIN_CONTRACT,
  mcp_plugin: MCP_PLUGIN_CONTRACT,
  host_plugin: HOST_PLUGIN_CONTRACT,
});
