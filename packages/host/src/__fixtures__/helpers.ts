// SPDX-License-Identifier: Apache-2.0
// Test helpers: a scratch Pathrule home, and a raw HTTP request whose headers the test controls
// (the client always sends the right ones).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST_RPC_VERSION, type HostRpcResponse } from "@pathrule/protocol/host-rpc.js";

export interface ScratchHome {
  dir: string;
  env: NodeJS.ProcessEnv;
  remove(): void;
}

/** A fresh Pathrule home; the env carries it as PATHRULE_HOME and nothing from the real one. */
export function scratchHome(): ScratchHome {
  // realpath: macOS hands out /var/... for a directory that lives at /private/var/...
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-host-")));
  const home = join(dir, ".pathrule");
  return {
    dir,
    env: { PATH: process.env.PATH, PATHRULE_HOME: home, PATHRULE_LOCAL_PRINCIPAL: "tester" },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface RawResponse {
  status: number;
  body: HostRpcResponse;
  headers: Record<string, string | string[] | undefined>;
}

export function rawRequest(input: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: input.port,
        method: input.method ?? "POST",
        path: input.path ?? "/rpc",
        headers: input.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), headers: res.headers });
          } catch {
            reject(new Error(`not JSON (${res.statusCode}): ${text}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

/** The headers a well-behaved client sends. */
export function goodHeaders(port: number, token: string): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export function envelope(method: string, params: unknown = {}, v = HOST_RPC_VERSION): string {
  return JSON.stringify({ v, id: 1, method, params });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns a value other than undefined, or throws after `timeoutMs`. */
export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: nothing after ${timeoutMs} ms`);
    await sleep(25);
  }
}
