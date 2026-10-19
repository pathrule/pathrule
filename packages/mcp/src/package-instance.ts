// SPDX-License-Identifier: Apache-2.0
// This copy of @pathrule/mcp. Its module state (the cache, the client identity and the plugin
// registry) must be the process's only copy, so the plugin seams compare this token with the one a
// plugin resolved (`@pathrule/protocol/package-instance.js`).
import { packageInstance } from "@pathrule/protocol/package-instance.js";

export const MCP_PACKAGE = packageInstance("@pathrule/mcp", import.meta.url);
