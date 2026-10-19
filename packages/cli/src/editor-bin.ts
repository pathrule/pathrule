// SPDX-License-Identifier: Apache-2.0
// The CLI the VS Code extension carries as its MCP server and its hook runner. It always composes
// Pathrule Cloud: the extension writes a Cloud MCP entry for a folder it attached to a Cloud
// workspace, and that server must serve the account, whatever mode a terminal CLI on the same
// machine chose. The `pathrule` binary of npm, Homebrew and the standalone tarball is ./index.ts,
// which loads Cloud when the person chose it.
import { CAPABILITIES } from "./capabilities/catalog.js";
import { main } from "./main.js";

await main(process.argv.slice(2), { plugins: CAPABILITIES.map((capability) => capability.load) });
