// SPDX-License-Identifier: Apache-2.0
/**
 * The contract version of each plugin seam. A seam refuses a plugin built against another version.
 *
 * A plugin package reports the version by reading it from its own copy of this package. `protocol`
 * is therefore a normal dependency of every plugin package and never a peer. A plugin from another
 * release resolves its own `protocol`, and with it the version it was built against. A peer would
 * hand it the host's number, and the check could never fail.
 *
 * Bump a version when its seam changes in a way an older plugin cannot meet.
 */

/**
 * `CommandPlugin`, the CLI's seam (`@pathrule/cli/plugin.js`). 2 since step 2l: a plugin names the
 * copies of the shared packages it resolved (`sharedPackages`).
 */
export const CLI_PLUGIN_CONTRACT = 2;

/** `McpPlugin`, the local MCP server's seam (`@pathrule/mcp/plugin.js`). */
export const MCP_PLUGIN_CONTRACT = 1;

/** `HostPlugin`, the Pathrule host's seam (`@pathrule/host/plugin.js`). */
export const HOST_PLUGIN_CONTRACT = 1;
