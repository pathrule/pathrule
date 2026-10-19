// SPDX-License-Identifier: Apache-2.0
import { startPathruleMcpServer } from "./server.js";
import { log } from "./logger.js";

// The open server's bin: the local store, no plugins. The reusable function lives in
// ./server.ts so a composition (the CLI's `pathrule mcp run`)
// can start it with its own plugins. Hook command + stdio safety are configured inside
// the function so import order from the caller does not matter.
startPathruleMcpServer().catch((err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
