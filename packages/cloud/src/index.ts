// SPDX-License-Identifier: Apache-2.0
// @pathrule/cloud: the Pathrule Cloud capability the CLI and the VS Code extension install for
// Cloud mode. The entry points are its modules: `cli/plugin.js` (the CLI plugin), `mcp/plugin.js`
// (the MCP server's account edition), `native/*` (the client of cloud.pathrule.io: session, tenancy,
// attached folders, the account edition) and the hook extension under `hook-supervisor/`.
// Depends on @pathrule/core; never the reverse.

export type { NativeAccount, NativeWorkspaceMapping } from "./native/account.js";
export { nativeCloudConfig, type NativeCloudConfig } from "./native/config.js";
