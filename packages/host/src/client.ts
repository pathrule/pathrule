// SPDX-License-Identifier: Apache-2.0
/**
 * How a Pathrule surface reaches the running host: read the discovery record, check the version,
 * shake hands, then call methods over the loopback RPC with a deadline.
 *
 * `connectHost` answers null when no host is running: no record, or a record whose process is gone.
 * It throws when a host is recorded but cannot be used (another RPC version, no answer, a record
 * replaced while connecting), because starting a second host for the home is never the fix.
 */
import { request } from "node:http";

import {
  HOST_RPC_PATH,
  HOST_RPC_VERSION,
  type HostDiscoveryRecord,
  type HostMethodName,
  type HostMethods,
  type HostRpcErrorCode,
  type HostRpcResponse,
} from "@pathrule/protocol/host-rpc.js";

import { processAlive, readHostRecord } from "./discovery.js";
import { LOOPBACK_HOST } from "./rpc-server.js";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export type HostClientErrorCode = HostRpcErrorCode | "unreachable" | "malformed_response";

export class HostClientError extends Error {
  readonly code: HostClientErrorCode;
  readonly status: number | undefined;
  /** The envelope error's `data`, when the host sent one. */
  readonly data: unknown;

  constructor(code: HostClientErrorCode, message: string, status?: number, data?: unknown) {
    super(message);
    this.name = "HostClientError";
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export interface HostCallOptions {
  timeoutMs?: number;
}

export interface HostClient {
  readonly record: Readonly<HostDiscoveryRecord>;
  /** One of the host's own methods. */
  call<M extends HostMethodName>(
    method: M,
    params: HostMethods[M]["params"],
    options?: HostCallOptions,
  ): Promise<HostMethods[M]["result"]>;
  /** A plugin's method, `<plugin name>.<method>`. */
  callPlugin(method: string, params?: unknown, options?: HostCallOptions): Promise<unknown>;
}

let nextId = 0;

function post(
  record: HostDiscoveryRecord,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: LOOPBACK_HOST,
        port: record.port,
        path: HOST_RPC_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${record.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on("error", (err) =>
      reject(new HostClientError("unreachable", `the host did not answer: ${err.message}`)),
    );
    req.end(body);
  });
}

/** A client for the host `record` describes. It does not check that the host is alive. */
export function createHostClient(record: HostDiscoveryRecord): HostClient {
  async function invoke(method: string, params: unknown, options: HostCallOptions = {}) {
    const id = (nextId += 1);
    const { status, text } = await post(
      record,
      JSON.stringify({ v: HOST_RPC_VERSION, id, method, params: params ?? {} }),
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    let response: HostRpcResponse;
    try {
      response = JSON.parse(text) as HostRpcResponse;
    } catch {
      throw new HostClientError(
        "malformed_response",
        `the host answered ${status} without JSON`,
        status,
      );
    }
    if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
      throw new HostClientError(
        "malformed_response",
        `the host answered ${status} without an envelope`,
        status,
      );
    }
    if (!response.ok) {
      const { code, message, data } = response.error;
      throw new HostClientError(code, message, status, data);
    }
    return response.result;
  }
  return {
    record,
    call: (method, params, options) => invoke(method, params, options) as never,
    callPlugin: (method, params, options) => invoke(method, params, options),
  };
}

/**
 * The running host of this Pathrule home, after a successful handshake; null when none is running.
 */
export async function connectHost(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<HostClient | null> {
  const record = await readHostRecord(options.env ?? process.env);
  if (!record || !processAlive(record.pid)) return null;
  if (record.rpc !== HOST_RPC_VERSION) {
    throw new HostClientError(
      "rpc_version_mismatch",
      `the running host (pid ${record.pid}) speaks host RPC ${record.rpc}; this client speaks ${HOST_RPC_VERSION}`,
    );
  }
  const client = createHostClient(record);
  const hello = await client.call(
    "host.hello",
    {},
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    },
  );
  if (hello.instanceId !== record.instance_id) {
    throw new HostClientError(
      "unreachable",
      "the host answering on the recorded port is not the one the record names",
    );
  }
  return client;
}
