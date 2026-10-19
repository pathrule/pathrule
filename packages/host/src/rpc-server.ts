// SPDX-License-Identifier: Apache-2.0
/**
 * The host's loopback RPC server: `POST /rpc` on 127.0.0.1, one JSON envelope per request.
 *
 * Every request passes these checks, in this order, before any method runs:
 * 1. **No `Origin`.** Browsers send it on every cross-origin request, so a web page can never
 *    reach the host.
 * 2. **`Host` is `127.0.0.1:<port>` or `localhost:<port>`.** A page that DNS-rebinds its own name
 *    to the loopback address still sends its own name.
 * 3. **The bearer token** of the discovery record, compared in constant time. Another local user
 *    cannot read the record (0600).
 * 4. **The path and method**, a JSON content type, a body within the limit, and an envelope of
 *    this `HOST_RPC_VERSION`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  HOST_RPC_PATH,
  HOST_RPC_VERSION,
  type HostRpcErrorCode,
  type HostRpcId,
  type HostRpcRequest,
  type HostRpcResponse,
} from "@pathrule/protocol/host-rpc.js";

import { HostRpcFailure } from "./methods.js";

export const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const STATUS: Record<HostRpcErrorCode, number> = {
  rpc_version_mismatch: 400,
  invalid_request: 400,
  invalid_params: 400,
  method_not_found: 404,
  unauthorized: 401,
  forbidden_origin: 403,
  forbidden_host: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  not_found: 404,
  method_not_allowed: 405,
  shutting_down: 503,
  timeout: 504,
  store_error: 500,
  internal_error: 500,
};

export interface HostRpcServerOptions {
  token: string;
  /** Runs one request's method. Throws `HostRpcFailure` to refuse it. */
  dispatch(request: HostRpcRequest, signal: AbortSignal): Promise<unknown>;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  log?(line: string): void;
}

export interface HostRpcServer {
  /** Binds 127.0.0.1 on an ephemeral port and returns it. */
  listen(): Promise<number>;
  /** New requests are answered `shutting_down` from now on. */
  refuseNew(): void;
  /**
   * Stops listening, waits up to `drainMs` for requests in flight, then drops every connection
   * that is left.
   */
  close(drainMs: number): Promise<void>;
  readonly inFlight: number;
}

/** Whether the request names this server: the loopback address or `localhost`, and its port. */
export function isLoopbackHost(host: string | undefined, port: number | undefined): boolean {
  if (!host || !port) return false;
  const value = host.toLowerCase();
  return value === `${LOOPBACK_HOST}:${port}` || value === `localhost:${port}`;
}

/** Constant-time: both sides are hashed first, so neither their content nor their length leaks. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const presented = createHash("sha256").update(header, "utf8").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
  return timingSafeEqual(presented, expected);
}

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class BodyTooLarge extends Error {}

/**
 * Reads the body up to `limit` bytes. Over the limit it stops reading and leaves the stream paused,
 * so the server can still answer 413 before it drops the connection. (Leaving a `for await` loop
 * early would destroy the socket, and the client would get no answer at all.)
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(single(req.headers["content-length"]));
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.off("data", onData);
        req.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseEnvelope(body: string): HostRpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HostRpcFailure("invalid_request", "the body is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostRpcFailure("invalid_request", "the body is not an envelope object");
  }
  const envelope = value as Partial<HostRpcRequest>;
  const idOk =
    (typeof envelope.id === "string" && envelope.id.length <= 128) ||
    (typeof envelope.id === "number" && Number.isFinite(envelope.id));
  if (typeof envelope.v !== "number" || !idOk || typeof envelope.method !== "string") {
    throw new HostRpcFailure("invalid_request", "an envelope needs a version, an id and a method");
  }
  return envelope as HostRpcRequest;
}

function respond(res: ServerResponse, status: number, body: HostRpcResponse): void {
  // A connection dropped while the method ran (the client left, or the drain deadline passed).
  if (res.headersSent || res.destroyed || res.socket?.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...(status === 405 ? { allow: "POST" } : {}),
    // The rest of an oversized body is discarded, not read: this connection is not reused.
    ...(status === 413 ? { connection: "close" } : {}),
  });
  res.end(text);
}

function failure(
  res: ServerResponse,
  id: HostRpcId | null,
  code: HostRpcErrorCode,
  message: string,
  data?: unknown,
): void {
  const error = data === undefined ? { code, message } : { code, message, data };
  respond(res, STATUS[code], { v: HOST_RPC_VERSION, id, ok: false, error });
}

/** How long the rest of an oversized body may keep arriving before the connection is cut. */
const DISCARD_GRACE_MS = 2_000;

export function createHostRpcServer(options: HostRpcServerOptions): HostRpcServer {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  let refusing = false;
  let inFlight = 0;
  const drainWaiters = new Set<() => void>();

  const settle = () => {
    inFlight -= 1;
    if (inFlight === 0) for (const wake of drainWaiters) wake();
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = req.socket.localPort;
    if (req.headers.origin !== undefined) {
      failure(res, null, "forbidden_origin", "browser requests are refused");
      return;
    }
    if (!isLoopbackHost(single(req.headers.host), port)) {
      failure(res, null, "forbidden_host", "the Host header must name this loopback server");
      return;
    }
    if (!bearerMatches(single(req.headers.authorization), options.token)) {
      failure(res, null, "unauthorized", "a valid bearer token is required");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path !== HOST_RPC_PATH) {
      failure(res, null, "not_found", `the host serves ${HOST_RPC_PATH} only`);
      return;
    }
    if (req.method !== "POST") {
      failure(res, null, "method_not_allowed", "use POST");
      return;
    }
    if (!isJsonContentType(single(req.headers["content-type"]))) {
      failure(res, null, "unsupported_media_type", "the body must be application/json");
      return;
    }
    if (refusing) {
      failure(res, null, "shutting_down", "the host is stopping");
      return;
    }

    inFlight += 1;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClose);
    let id: HostRpcId | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      let body: string;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          failure(res, null, "payload_too_large", `the body exceeds ${maxBodyBytes} bytes`);
          // Discard the rest instead of closing at once: a socket closed with unread data resets
          // the connection, and the client would lose the answer. One that keeps sending is cut off.
          const cutOff = setTimeout(() => req.destroy(), DISCARD_GRACE_MS);
          cutOff.unref();
          req.once("end", () => clearTimeout(cutOff));
          req.resume();
          return;
        }
        throw err;
      }
      const request = parseEnvelope(body);
      id = request.id;
      if (request.v !== HOST_RPC_VERSION) {
        throw new HostRpcFailure(
          "rpc_version_mismatch",
          `the client speaks host RPC ${request.v}; this host speaks ${HOST_RPC_VERSION}`,
        );
      }
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new HostRpcFailure(
              "timeout",
              `${request.method} took longer than ${requestTimeoutMs} ms`,
            ),
          );
        }, requestTimeoutMs);
      });
      const result = await Promise.race([options.dispatch(request, controller.signal), deadline]);
      respond(res, 200, { v: HOST_RPC_VERSION, id, ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof HostRpcFailure) {
        failure(res, id, err.code, err.message, err.data);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log(`rpc internal_error ${message}`);
        failure(res, id, "internal_error", message);
      }
    } finally {
      if (timer) clearTimeout(timer);
      res.off("close", onClose);
      settle();
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`rpc handler crashed ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) failure(res, null, "internal_error", "the host could not answer");
    });
  });

  return {
    get inFlight() {
      return inFlight;
    },
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK_HOST, () => {
          server.off("error", reject);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("the host could not bind a loopback port"));
            return;
          }
          resolve(address.port);
        });
      });
    },
    refuseNew() {
      refusing = true;
    },
    async close(drainMs: number) {
      refusing = true;
      if (!server.listening) return;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, drainMs);
          drainWaiters.add(done);
          function done() {
            clearTimeout(timer);
            drainWaiters.delete(done);
            resolve();
          }
        });
      }
      server.closeAllConnections();
      await closed;
    },
  };
}
