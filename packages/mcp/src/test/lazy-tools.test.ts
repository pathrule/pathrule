// SPDX-License-Identifier: Apache-2.0
// Drive the stdio MCP server through a real in-memory MCP client
// and assert the read/write split: lazy mode advertises the read set +
// log_activity + enable_writes and defers the write/admin tools until
// enable_writes runs; all mode advertises everything upfront.
//
// The DEFAULT flipped to all (2026-09-01). Lazy saved 7.682 tokens of tool
// schema, but that schema lives in the cached prefix while `enable_writes`
// CHANGES the advertised tool list, which invalidates that prefix and re-bills
// the conversation so far as fresh input. The saving is constant; the invalidation
// scales with session length, so lazy was cheapest exactly where it mattered least.

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { startPathruleMcpServer } from "../server.js";

const SAMPLE_WRITE_TOOLS = [
  "pathrule_write_memory",
  "pathrule_update_rule",
  "pathrule_delete_skill",
  "pathrule_remove_pattern",
  "pathrule_import_pattern",
];

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startPathruleMcpServer({ transport: serverTransport, stdioSafe: false });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function listToolNames(client: Client): Promise<Set<string>> {
  const { tools } = await client.listTools();
  return new Set(tools.map((t) => t.name));
}

describe("MCP read/write split", () => {
  const original = process.env.PATHRULE_MCP_TOOLS;
  const openClients: Client[] = [];

  afterEach(async () => {
    if (original === undefined) delete process.env.PATHRULE_MCP_TOOLS;
    else process.env.PATHRULE_MCP_TOOLS = original;
    for (const c of openClients) await c.close().catch(() => {});
    openClients.length = 0;
  });

  it("lazy mode advertises reads + log_activity + enable_writes, defers writes", async () => {
    process.env.PATHRULE_MCP_TOOLS = "lazy";
    const client = await connectedClient();
    openClients.push(client);

    const names = await listToolNames(client);
    // Always-on read path + the mandatory log loop + the enable gate.
    expect(names.has("pathrule_get_context")).toBe(true);
    expect(names.has("pathrule_read_memory")).toBe(true);
    expect(names.has("pathrule_log_activity")).toBe(true);
    expect(names.has("pathrule_enable_writes")).toBe(true);
    // Write/admin set is deferred — not advertised yet.
    for (const w of SAMPLE_WRITE_TOOLS) {
      expect(names.has(w), `${w} should be deferred in lazy mode`).toBe(false);
    }
  });

  it("enable_writes makes the deferred write tools callable in-session", async () => {
    process.env.PATHRULE_MCP_TOOLS = "lazy";
    const client = await connectedClient();
    openClients.push(client);

    const before = await listToolNames(client);
    expect(before.has("pathrule_write_memory")).toBe(false);

    const res = (await client.callTool({ name: "pathrule_enable_writes", arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0]?.text ?? "{}";
    const payload = JSON.parse(text) as { ok: boolean; enabled_count: number };
    expect(payload.ok).toBe(true);
    expect(payload.enabled_count).toBeGreaterThan(0);

    const after = await listToolNames(client);
    for (const w of SAMPLE_WRITE_TOOLS) {
      expect(after.has(w), `${w} should be advertised after enable_writes`).toBe(true);
    }
    // Read tools and log_activity are still there — nothing was removed.
    expect(after.has("pathrule_get_context")).toBe(true);
    expect(after.has("pathrule_log_activity")).toBe(true);
  });

  it("core mode advertises the everyday tools and the more_tools gate", async () => {
    process.env.PATHRULE_MCP_TOOLS = "core";
    const client = await connectedClient();
    openClients.push(client);

    const names = await listToolNames(client);
    for (const w of ["pathrule_get_context", "pathrule_read_memory", "pathrule_write_memory", "pathrule_update_memory", "pathrule_write_rule", "pathrule_remember_preference", "pathrule_import_pattern", "pathrule_log_activity", "pathrule_more_tools"]) {
      expect(names.has(w), `${w} should be advertised in core mode`).toBe(true);
    }
    for (const w of ["pathrule_get_tree", "pathrule_delete_skill", "pathrule_remove_pattern", "pathrule_review_history", "pathrule_enable_writes"]) {
      expect(names.has(w), `${w} should not be advertised in core mode`).toBe(false);
    }
    const res = (await client.callTool({ name: "pathrule_more_tools", arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect((JSON.parse(res.content[0]?.text ?? "{}") as { ok: boolean }).ok).toBe(true);
    const after = await listToolNames(client);
    expect(after.has("pathrule_get_tree")).toBe(true);
    expect(after.has("pathrule_delete_skill")).toBe(true);
  });

  it("all mode (default) advertises every tool upfront and omits the enable gate", async () => {
    delete process.env.PATHRULE_MCP_TOOLS;
    const client = await connectedClient();
    openClients.push(client);

    const names = await listToolNames(client);
    for (const w of SAMPLE_WRITE_TOOLS) {
      expect(names.has(w), `${w} should be advertised upfront in all mode`).toBe(true);
    }
    expect(names.has("pathrule_enable_writes")).toBe(false);
    expect(names.has("pathrule_more_tools")).toBe(false);
  });

  it("the default advertises a tool list that never changes mid-session", async () => {
    delete process.env.PATHRULE_MCP_TOOLS;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await startPathruleMcpServer({ transport: serverTransport, stdioSafe: false });
    const client = new Client({ name: "test", version: "0.0.0" });
    let changes = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changes += 1;
    });
    await client.connect(clientTransport);
    openClients.push(client);

    const before = await listToolNames(client);
    // Anything a session does cannot move the list, because there is no gate to open.
    expect(before.has("pathrule_enable_writes")).toBe(false);
    expect(before.has("pathrule_more_tools")).toBe(false);
    expect(before.has("pathrule_write_memory")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(changes, "the default must never invalidate the cached tool list").toBe(0);
  });

  it("lazy mode emits ONE tools/list_changed, not one per tool", async () => {
    process.env.PATHRULE_MCP_TOOLS = "lazy";
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await startPathruleMcpServer({ transport: serverTransport, stdioSafe: false });
    const client = new Client({ name: "test", version: "0.0.0" });
    let changes = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changes += 1;
    });
    await client.connect(clientTransport);
    openClients.push(client);

    await client.callTool({ name: "pathrule_enable_writes", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    // 14 tools become visible; the list changed once. Measured before the fix: 14.
    expect(changes).toBe(1);

    // Idempotent: a second call changes nothing, so it must not notify at all.
    await client.callTool({ name: "pathrule_enable_writes", arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(changes).toBe(1);
  });
});
