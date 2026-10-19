// SPDX-License-Identifier: Apache-2.0
// The bin of the npm package @pathrule/mcp: Pathrule's MCP server over stdio, for an AI client that
// launches it with `npx -y @pathrule/mcp`. It is `pathrule mcp run` of the same CLI, so it serves
// the mode the person chose with `pathrule setup` (the local store, or Pathrule Cloud, which this
// package carries) and never anything else.
//
// The server launches the home's stores host as `<node> <this bin> host run` (local/self-command.ts),
// so `host` passes through as the CLI's own command.
import { main } from "./main.js";

const args = process.argv.slice(2);
await main(args[0] === "host" ? args : ["mcp", "run", ...args], { discoverPlugins: true });
