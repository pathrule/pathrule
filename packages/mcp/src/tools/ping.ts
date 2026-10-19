// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { resolveClientId } from "../client-identity.js";
import { mcpCompatibilityReport, mcpServerVersion } from "../server-version.js";
import type { ToolDef } from "./types.js";

/**
 * Live tool used by the M5 smoke test. Echoes the cwd + a timestamp so
 * Claude Code (or any MCP client) can confirm the server sees the
 * spawning shell's working directory correctly.
 */
export const pingTool: ToolDef<{ message?: string }> = {
  name: "pathrule_ping",
  title: "Pathrule Ping",
  description:
    "Sanity check that Pathrule's MCP server is wired up. Returns the current working directory, a timestamp, the server's version and contracts, and any update or restart the user should know about. Use this to verify the Claude Code ↔ Pathrule bridge.",
  inputSchema: {
    message: z.string().optional().describe("Optional message to echo back."),
  },
  handler: async (args) => ({
    pong: true,
    echo: args.message ?? null,
    cwd: process.cwd(),
    ts: new Date().toISOString(),
    version: mcpServerVersion(),
    compatibility: mcpCompatibilityReport({ env: process.env, clientId: resolveClientId() }),
  }),
};
