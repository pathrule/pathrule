// SPDX-License-Identifier: Apache-2.0
/**
 * Dev harness that spawns the built MCP server as a subprocess and
 * exercises the JSON-RPC wire protocol directly. Useful for verifying
 * the tool list + a canonical tool call without needing Claude Code.
 *
 * Run with:
 *   pnpm --filter @pathrule/mcp build:bin
 *   pnpm --filter @pathrule/mcp harness
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, "..", "dist-bin", "index.js");

const pending = new Map<number, (value: JsonRpcResponse) => void>();
let nextId = 1;

async function main() {
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server-stderr] ${chunk.toString()}`);
  });

  let buffer = "";
  server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number") {
          const resolver = pending.get(msg.id);
          if (resolver) {
            pending.delete(msg.id);
            resolver(msg);
          }
        }
      } catch (err) {
        console.error("[harness] failed to parse line", line, err);
      }
    }
  });

  function call(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve) => {
      pending.set(id, resolve);
      server.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    const req: JsonRpcRequest = { jsonrpc: "2.0", method, params };
    server.stdin.write(JSON.stringify(req) + "\n");
  }

  function log(label: string, value: unknown): void {
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(value, null, 2));
  }

  try {
    const init = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pathrule-dev-harness", version: "0.1" },
    });
    log("initialize", init.result);
    notify("notifications/initialized");

    const list = await call("tools/list", {});
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    log(
      "tools/list",
      tools.map((t) => t.name),
    );

    const ping = await call("tools/call", {
      name: "pathrule_ping",
      arguments: { message: "hello from harness" },
    });
    log("tools/call pathrule_ping", ping.result);

    const stub = await call("tools/call", {
      name: "pathrule_get_context",
      arguments: { cwd: process.cwd() },
    });
    log("tools/call pathrule_get_context", stub.result);

    server.stdin.end();
    await new Promise<void>((resolve) => {
      server.on("exit", () => resolve());
    });
  } catch (err) {
    console.error("[harness] error", err);
    server.kill();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[harness] fatal", err);
  process.exit(1);
});
