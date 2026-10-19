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
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pathrule-host-")));
  const home = join(dir, ".pathrule");
  return {
    dir,
    env: { PATH: process.env.PATH, PATHRULE_HOME: home, PATHRULE_LOCAL_PRINCIPAL: "tester" },
    remove: () => removeScratch(dir),
  };
}

/**
 * Windows refuses to delete a folder while a process holds a file in it open, and a host a test
 * launched can still be letting go of its store when the test ends: retry, then leave the scratch
 * folder to the OS temp cleanup rather than fail the test on it. POSIX removes it at once.
 */
function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) throw error;
  }
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
