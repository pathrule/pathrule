// SPDX-License-Identifier: Apache-2.0
// The loopback HTTP server of `pathrule ui`: the built Local Console, its JSON API, and the control
// endpoint a second `pathrule ui` uses. It binds 127.0.0.1 only, and every request passes these
// checks before anything else runs:
//
//   - `Host` is `127.0.0.1:<port>` or `localhost:<port>`: a page that rebinds its own name to the
//     loopback address still sends its own name (421 otherwise).
//
// `/api/<route>` (the contract: @pathrule/protocol/local-ui-api.ts), in this order:
//   - `POST` only (405);
//   - an `Origin` equal to this server's own origin for the Host used, and a `Sec-Fetch-Site`, when
//     present, of `same-origin` (403): another site's page never reaches the API, and no CORS
//     header is ever sent;
//   - `Content-Type: application/json` (415);
//   - `Authorization: Bearer <session>`, except `/api/session`, which trades a launch token for one
//     (401);
//   - a known route (404), a body within 256 KB (413) that is a JSON object (400), answered within
//     15 s (408 while the body arrives, 504 while the route runs).
//
// `/control/launch` refuses anything a browser sends (an `Origin` or a `Sec-Fetch-Site`) and needs
// the control token from `<Pathrule home>/ui.json`. Every other path serves the console's files
// (`GET`/`HEAD`). No cookie is read or set. Every answer carries the security headers below; an
// `index.html` answer also allows the one `<style>` nonce it was given (`UI_STYLE_NONCE_PLACEHOLDER`).
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  LOCAL_UI_ROUTES,
  type LocalUiError,
  type LocalUiRoute,
  type SessionResponse,
} from "@pathrule/protocol/local-ui-api.js";

import { contentTypeOf, lookupAsset, notBuiltPage } from "./assets.js";
import { bearerToken, tokenDigest, tokenMatches, UiTokens } from "./tokens.js";

export const UI_LOOPBACK_HOST = "127.0.0.1";
export const UI_MAX_BODY_BYTES = 256 * 1024;
export const UI_REQUEST_TIMEOUT_MS = 15_000;
const CONTROL_MAX_BODY_BYTES = 4 * 1024;
/** How long the rest of an oversized body may keep arriving before the connection is cut. */
const DISCARD_GRACE_MS = 2_000;

/** The policy of every answer; `index.html` adds its per-response style nonce (`stylePolicy`). */
export function contentSecurityPolicy(styleNonce?: string): string {
  const style = styleNonce ? `style-src 'self' 'nonce-${styleNonce}'` : "style-src 'self'";
  return (
    `default-src 'none'; script-src 'self'; ${style}; img-src 'self' data:; ` +
    "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

export const UI_CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/**
 * The placeholder the built `index.html` carries (`<meta name="pr-style-nonce" content="...">`),
 * replaced on every answer with a fresh nonce that the response's policy allows for `<style>`
 * elements: the console's dialogs inject one at runtime (a scroll lock).
 */
export const UI_STYLE_NONCE_PLACEHOLDER = "__PR_STYLE_NONCE__";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": UI_CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export type LocalUiErrorCode = LocalUiError["error"]["code"];

/** A refusal a route throws; the server answers it as a `LocalUiError`. */
export class LocalUiApiError extends Error {
  readonly code: LocalUiErrorCode;
  readonly status: number;

  constructor(code: LocalUiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "LocalUiApiError";
    this.code = code;
    this.status = status ?? STATUS[code];
  }
}

const STATUS: Record<LocalUiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  timeout: 504,
  unavailable: 503,
  internal: 500,
};

/** The routes the API serves; `session` is the server's own. */
export type LocalUiApiRoute = Exclude<LocalUiRoute, "session">;

export interface LocalUiApi {
  /** Answers one route with its response body. Throws `LocalUiApiError` to refuse. */
  handle(route: LocalUiApiRoute, body: Record<string, unknown>): Promise<unknown>;
}

export interface LocalUiServerOptions {
  api: LocalUiApi;
  /** The built console, or null to answer every page with how to build it. */
  assetsDir: string | null;
  /** 0 (the default): any free port. */
  port?: number;
  tokens?: UiTokens;
  /** Enables `/control/launch` for a caller that holds it. */
  controlToken?: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  log?(line: string): void;
}

export interface LocalUiServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** A fresh single-use link: `http://127.0.0.1:<port>/#launch=<token>`. */
  launchUrl(): string;
  close(): Promise<void>;
}

const ROUTES: ReadonlySet<string> = new Set(LOCAL_UI_ROUTES);

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isJsonContentType(value: string | undefined): boolean {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

class BodyTooLarge extends Error {}
class BodyTimedOut extends Error {}

/**
 * Reads the body up to `limit` bytes before `deadline`. Over the limit it stops reading and leaves
 * the stream paused, so the server can still answer 413 before it drops the connection.
 */
function readBody(req: IncomingMessage, limit: number, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(single(req.headers["content-length"]));
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BodyTimedOut())),
      Math.max(0, deadline - Date.now()),
    );
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(() => {
          req.pause();
          reject(new BodyTooLarge());
        });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.once("error", (err) => finish(() => reject(err)));
  });
}

function writeHead(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
): boolean {
  if (res.headersSent || res.destroyed || res.socket?.destroyed) return false;
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  return true;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = JSON.stringify(body ?? null);
  if (
    !writeHead(res, status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(text),
      ...extra,
    })
  ) {
    return;
  }
  res.end(text);
}

function fail(
  res: ServerResponse,
  status: number,
  code: LocalUiErrorCode,
  message: string,
  extra: Record<string, string> = {},
): void {
  const body: LocalUiError = { error: { code, message } };
  sendJson(res, status, body, extra);
}

function sendHtml(res: ServerResponse, status: number, html: string, head: boolean): void {
  if (
    !writeHead(res, status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(html),
    })
  ) {
    return;
  }
  res.end(head ? undefined : html);
}

export async function startLocalUiServer(options: LocalUiServerOptions): Promise<LocalUiServer> {
  const tokens = options.tokens ?? new UiTokens();
  const maxBodyBytes = options.maxBodyBytes ?? UI_MAX_BODY_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? UI_REQUEST_TIMEOUT_MS;
  const controlDigest = options.controlToken ? tokenDigest(options.controlToken) : null;
  const log = options.log ?? (() => {});
  let port = 0;

  /**
   * After answering early: discard the rest of the body instead of closing at once (a socket closed
   * with unread data resets the connection, and the client would lose the answer), and cut off a
   * client that keeps sending or never finishes.
   */
  function discardRest(req: IncomingMessage): void {
    const cutOff = setTimeout(() => req.destroy(), DISCARD_GRACE_MS);
    cutOff.unref();
    req.once("end", () => clearTimeout(cutOff));
    req.resume();
  }

  function tooLarge(req: IncomingMessage, res: ServerResponse, limit: number): void {
    fail(res, 413, "payload_too_large", `The body exceeds ${limit} bytes.`, {
      connection: "close",
    });
    discardRest(req);
  }

  function bodyTimedOut(req: IncomingMessage, res: ServerResponse): void {
    fail(res, 408, "timeout", "The request body did not arrive in time.", {
      connection: "close",
    });
    discardRest(req);
  }

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    hostName: string,
    path: string,
  ): Promise<void> {
    const deadline = Date.now() + requestTimeoutMs;
    if (req.method !== "POST") {
      fail(res, 405, "bad_request", "The API answers POST only.", { allow: "POST" });
      return;
    }
    const origin = single(req.headers.origin);
    if (origin === undefined) {
      fail(res, 403, "forbidden", "An Origin header is required.");
      return;
    }
    if (origin !== `http://${hostName}:${port}`) {
      fail(res, 403, "forbidden", "Requests from another origin are refused.");
      return;
    }
    const site = single(req.headers["sec-fetch-site"]);
    if (site !== undefined && site !== "same-origin") {
      fail(res, 403, "forbidden", "Only same-origin requests reach the API.");
      return;
    }
    if (!isJsonContentType(single(req.headers["content-type"]))) {
      fail(res, 415, "bad_request", "The body must be application/json.");
      return;
    }
    const route = path.slice("/api/".length);
    const isSession = route === "session";
    if (!isSession && !tokens.sessionValid(bearerToken(single(req.headers.authorization)))) {
      fail(res, 401, "unauthorized", "A valid session is required. Run `pathrule ui` again.");
      return;
    }
    if (!ROUTES.has(route)) {
      fail(res, 404, "not_found", `No route "${route}".`);
      return;
    }

    let text: string;
    try {
      text = await readBody(req, maxBodyBytes, deadline);
    } catch (err) {
      if (err instanceof BodyTooLarge) return tooLarge(req, res, maxBodyBytes);
      if (err instanceof BodyTimedOut) return bodyTimedOut(req, res);
      throw err;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      fail(res, 400, "bad_request", "The body is not JSON.");
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      fail(res, 400, "bad_request", "The body must be a JSON object.");
      return;
    }

    if (isSession) {
      const launchToken = (body as { launchToken?: unknown }).launchToken;
      const session = tokens.redeemLaunch(
        typeof launchToken === "string" ? launchToken : undefined,
      );
      if (!session) {
        fail(
          res,
          401,
          "unauthorized",
          "This launch link was already used or has expired. Run `pathrule ui` again for a new one.",
        );
        return;
      }
      const response: SessionResponse = {
        sessionToken: session.sessionToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
      sendJson(res, 200, response);
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        options.api.handle(route as LocalUiApiRoute, body as Record<string, unknown>),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new LocalUiApiError(
                  "timeout",
                  `${route} did not answer within ${requestTimeoutMs} ms.`,
                ),
              ),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof LocalUiApiError) {
        fail(res, err.status, err.code, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`${route} failed: ${message}`);
      fail(res, 500, "internal", message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!controlDigest) {
      fail(res, 404, "not_found", "No such path.");
      return;
    }
    // A browser always sends one of these; the control endpoint is for this user's own CLI.
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) {
      fail(res, 403, "forbidden", "Browser requests are refused.");
      return;
    }
    if (req.method !== "POST") {
      fail(res, 405, "bad_request", "Use POST.", { allow: "POST" });
      return;
    }
    if (!tokenMatches(bearerToken(single(req.headers.authorization)), controlDigest)) {
      fail(res, 401, "unauthorized", "The control token is required.");
      return;
    }
    try {
      await readBody(req, CONTROL_MAX_BODY_BYTES, Date.now() + requestTimeoutMs);
    } catch (err) {
      if (err instanceof BodyTooLarge) return tooLarge(req, res, CONTROL_MAX_BODY_BYTES);
      if (err instanceof BodyTimedOut) return bodyTimedOut(req, res);
      throw err;
    }
    sendJson(res, 200, { launchUrl: launchUrl(), port, pid: process.pid });
  }

  function assets(req: IncomingMessage, res: ServerResponse, path: string): void {
    const head = req.method === "HEAD";
    if (req.method !== "GET" && !head) {
      fail(res, 405, "bad_request", "Use GET.", { allow: "GET, HEAD" });
      return;
    }
    if (!options.assetsDir) {
      sendHtml(res, 200, notBuiltPage(), head);
      return;
    }
    const found = lookupAsset(options.assetsDir, path);
    if (found.kind === "bad_request") return fail(res, 400, "bad_request", "Malformed path.");
    if (found.kind === "forbidden") return fail(res, 403, "forbidden", "Outside the console.");
    if (found.kind === "not_found") return fail(res, 404, "not_found", "No such file.");
    if (found.index) {
      // Read whole (it is small) to give this answer its own style nonce.
      let html: string;
      try {
        html = readFileSync(found.file, "utf8");
      } catch {
        fail(res, 404, "not_found", "No such file.");
        return;
      }
      const nonce = randomBytes(18).toString("base64");
      const body = html.split(UI_STYLE_NONCE_PLACEHOLDER).join(nonce);
      if (
        !writeHead(res, 200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "content-security-policy": contentSecurityPolicy(nonce),
        })
      ) {
        return;
      }
      res.end(head ? undefined : body);
      return;
    }
    let size: number;
    try {
      size = statSync(found.file).size;
    } catch {
      fail(res, 404, "not_found", "No such file.");
      return;
    }
    if (
      !writeHead(res, 200, {
        "content-type": contentTypeOf(found.file),
        "content-length": size,
        "cache-control": "public, max-age=31536000, immutable",
      })
    ) {
      return;
    }
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(found.file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = single(req.headers.host)?.toLowerCase();
    const hostName =
      host === `${UI_LOOPBACK_HOST}:${port}`
        ? UI_LOOPBACK_HOST
        : host === `localhost:${port}`
          ? "localhost"
          : null;
    if (!hostName) {
      fail(res, 421, "forbidden", "The Host header must name this loopback server.");
      return;
    }
    const url = req.url ?? "/";
    if (!url.startsWith("/")) {
      fail(res, 400, "bad_request", "Malformed request target.");
      return;
    }
    const path = url.split("?")[0]!;
    if (path === "/control/launch") return control(req, res);
    if (path === "/api" || path.startsWith("/api/")) return api(req, res, hostName, path);
    assets(req, res, path);
  }

  const server: Server = createServer(
    {
      // Backstops for a client that never finishes its headers or body; the API's own deadline
      // answers first with a LocalUiError.
      headersTimeout: requestTimeoutMs,
      requestTimeout: requestTimeoutMs + 1_000,
      connectionsCheckingInterval: Math.min(1_000, requestTimeoutMs),
      // A request without a Host reaches the check below, which answers it with this server's
      // headers instead of Node's bare 400.
      requireHostHeader: false,
    },
    (req, res) => {
      void handle(req, res).catch((err: unknown) => {
        log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) fail(res, 500, "internal", "The request could not be answered.");
        else res.destroy();
      });
    },
  );

  port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, UI_LOOPBACK_HOST, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("pathrule ui could not bind a loopback port"));
        return;
      }
      resolve(address.port);
    });
  });
  const origin = `http://${UI_LOOPBACK_HOST}:${port}`;

  function launchUrl(): string {
    return `${origin}/#launch=${tokens.mintLaunch()}`;
  }

  let closing: Promise<void> | null = null;
  return {
    port,
    origin,
    launchUrl,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        // Requests in flight get a moment; then every connection goes.
        setTimeout(() => server.closeAllConnections(), 1_000).unref();
      });
      return closing;
    },
  };
}
