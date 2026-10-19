// SPDX-License-Identifier: Apache-2.0
// The official compositions' tool list: the open server's tools, in the open server's order, and
// nothing else. Pathrule Cloud's account edition serves the same tools over its Project backend
// and adds none, so the cached prompt prefix is the same under every edition.

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startPathruleMcpServer } from "@pathrule/mcp/server.js";
import type { McpPlugin } from "@pathrule/mcp/plugin.js";

import { cloudMcpPlugin } from "../plugin.js";

const original = process.env.PATHRULE_MCP_TOOLS;
const clients: Client[] = [];
afterEach(async () => {
  if (original === undefined) delete process.env.PATHRULE_MCP_TOOLS;
  else process.env.PATHRULE_MCP_TOOLS = original;
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
});

async function advertised(plugins: McpPlugin[]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startPathruleMcpServer({ transport: serverTransport, stdioSafe: false, plugins });
  const client = new Client({ name: "official-tools", version: "1" });
  clients.push(client);
  await client.connect(clientTransport);
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("the official MCP tool list", () => {
  it("is the open server's list, in its order, with the account edition installed", async () => {
    const official = await advertised([cloudMcpPlugin()]);
    expect(official).toEqual(await advertised([]));
    expect(official.length).toBeGreaterThan(20);
    expect(official).not.toContain("pathrule_setup");
    expect(official).not.toContain("pathrule_goto");
  });
});
