// SPDX-License-Identifier: Apache-2.0
// The security rules of the `pathrule ui` server, each on its own: the Host check (DNS rebinding),
// the API's method, Origin, Sec-Fetch-Site, content type, bearer session, launch tokens (single use,
// expiring), body cap, deadlines and error bodies; the control endpoint; and the static files
// (cache headers, the SPA fallback, path traversal, the page shown before the console is built).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UI_ASSETS_BUILD_COMMAND } from "./assets.js";
import {
  contentSecurityPolicy,
  LocalUiApiError,
  startLocalUiServer,
  UI_CONTENT_SECURITY_POLICY,
  type LocalUiApi,
  type LocalUiServer,
  type LocalUiServerOptions,
} from "./server.js";
import { LAUNCH_TOKEN_TTL_MS, UiTokens } from "./tokens.js";

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: { error?: { code: string; message: string } } & Record<string, unknown>;
}

function send(
  port: number,
  input: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** Leave the Host header out entirely. */
    noHost?: boolean;
    /** Send the body in chunks without a content length. */
    chunked?: boolean;
  },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: input.method ?? "GET",
        path: input.path,
        headers: input.headers ?? {},
        setHost: !input.noHost,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Answer["json"] = {};
          try {
            json = JSON.parse(text) as Answer["json"];
          } catch {
            // Not JSON (a page, a file).
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (input.body !== undefined && input.chunked) {
      const body = Buffer.from(input.body);
      const step = 64 * 1024;
      for (let i = 0; i < body.length; i += step) req.write(body.subarray(i, i + step));
      req.end();
    } else {
      req.end(input.body);
    }
  });
}

class FakeApi implements LocalUiApi {
  calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  answer: (route: string, body: Record<string, unknown>) => Promise<unknown> = async (route) => ({
    ok: route,
  });
  handle(route: string, body: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ route, body });
    return this.answer(route, body);
  }
}

let dir: string;
let assets: string;
let server: LocalUiServer | null;
let api: FakeApi;
let now: number;
let tokens: UiTokens;

async function start(overrides: Partial<LocalUiServerOptions> = {}): Promise<LocalUiServer> {
  server = await startLocalUiServer({
    api,
    assetsDir: assets,
    tokens,
    controlToken: "control-token",
    ...overrides,
  });
  return server;
}

/** The headers a same-origin fetch from the console sends. */
function apiHeaders(s: LocalUiServer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${s.port}`,
    origin: s.origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

/** The nonce of the page's `<meta name="pr-style-nonce">`. */
function metaNonce(html: string): string {
  const match = /<meta name="pr-style-nonce" content="([^"]+)">/.exec(html);
  expect(match).not.toBeNull();
  return match![1]!;
}

function launchToken(s: LocalUiServer): string {
  return new URL(s.launchUrl()).hash.slice("#launch=".length);
}

async function sessionFor(s: LocalUiServer): Promise<string> {
  const answer = await send(s.port, {
    method: "POST",
    path: "/api/session",
    headers: apiHeaders(s),
    body: JSON.stringify({ launchToken: launchToken(s) }),
  });
  expect(answer.status).toBe(200);
  return answer.json.sessionToken as string;
}

function call(s: LocalUiServer, route: string, session: string, body: unknown = {}) {
  return send(s.port, {
    method: "POST",
    path: `/api/${route}`,
    headers: apiHeaders(s, { authorization: `Bearer ${session}` }),
    body: JSON.stringify(body),
  });
}

function expectSecurityHeaders(answer: Answer, styleNonce?: string): void {
  expect(answer.headers["content-security-policy"]).toBe(
    styleNonce ? contentSecurityPolicy(styleNonce) : UI_CONTENT_SECURITY_POLICY,
  );
  expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  expect(answer.headers["referrer-policy"]).toBe("no-referrer");
  expect(answer.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(answer.headers["cross-origin-resource-policy"]).toBe("same-origin");
  for (const name of Object.keys(answer.headers)) {
    expect(name.startsWith("access-control-")).toBe(false);
  }
  expect(answer.headers["set-cookie"]).toBeUndefined();
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-ui-server-")));
  assets = join(dir, "dist");
  mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(
    join(assets, "index.html"),
    '<!doctype html><meta name="pr-style-nonce" content="__PR_STYLE_NONCE__"><title>console</title>',
  );
  writeFileSync(join(assets, "assets", "app-1234.js"), "console.log('app');");
  writeFileSync(join(dir, "secret.txt"), "TOP SECRET");
  api = new FakeApi();
  now = 1_000_000;
  tokens = new UiTokens({ now: () => now });
  server = null;
});

afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("pathrule ui server: Host", () => {
  it("binds the loopback address", async () => {
    const s = await start();
    expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.launchUrl()).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/#launch=[\\w-]{43}$`),
    );
  });

  it("refuses a Host that is not this loopback server (DNS rebinding)", async () => {
    const s = await start();
    for (const host of [
      `evil.example:${s.port}`,
      "evil.example",
      `127.0.0.1:${s.port + 1}`,
      `localhost:${s.port + 1}`,
      `127.0.0.1`,
      `[::1]:${s.port}`,
    ]) {
      const answer = await send(s.port, { path: "/", headers: { host } });
      expect(answer.status, host).toBe(421);
      expect(answer.json.error?.code).toBe("forbidden");
      expectSecurityHeaders(answer);
    }
    const noHost = await send(s.port, { path: "/", noHost: true });
    expect(noHost.status).toBe(421);
    // Refused before the API looks at anything else, with a valid session or not.
    const session = await sessionFor(s);
    const rebound = await send(s.port, {
      method: "POST",
      path: "/api/workspaces.list",
      headers: {
        ...apiHeaders(s, { authorization: `Bearer ${session}` }),
        host: `evil.example:${s.port}`,
        origin: `http://evil.example:${s.port}`,
      },
      body: "{}",
    });
    expect(rebound.status).toBe(421);
    expect(api.calls).toEqual([]);
  });

  it("serves both loopback names", async () => {
    const s = await start();
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `LOCALHOST:${s.port}`]) {
      expect((await send(s.port, { path: "/", headers: { host } })).status, host).toBe(200);
    }
  });
});

describe("pathrule ui server: the API", () => {
  it("answers POST only", async () => {
    const s = await start();
    const session = await sessionFor(s);
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const answer = await send(s.port, {
        method,
        path: "/api/workspaces.list",
        headers: apiHeaders(s, { authorization: `Bearer ${session}` }),
      });
      expect(answer.status, method).toBe(405);
      expect(answer.headers.allow).toBe("POST");
      expect(answer.json.error?.code).toBe("bad_request");
      // A preflight is never answered with CORS headers.
      expectSecurityHeaders(answer);
    }
    expect(api.calls).toEqual([]);
  });

  it("requires an Origin, and only this server's own for the Host used", async () => {
    const s = await start();
    const session = await sessionFor(s);
    const auth = { authorization: `Bearer ${session}` };
    const { origin: _origin, ...withoutOrigin } = apiHeaders(s, auth);
    const missing = await send(s.port, {
      method: "POST",
      path: "/api/workspaces.list",
      headers: withoutOrigin,
      body: "{}",
    });
    expect(missing.status).toBe(403);
    expect(missing.json.error).toEqual({
      code: "forbidden",
      message: "An Origin header is required.",
    });
    for (const origin of [
      "http://evil.example",
      `https://127.0.0.1:${s.port}`,
      `http://127.0.0.1:${s.port + 1}`,
      // The other loopback name than the Host used.
      `http://localhost:${s.port}`,
      "null",
    ]) {
      const answer = await send(s.port, {
        method: "POST",
        path: "/api/workspaces.list",
        headers: apiHeaders(s, { ...auth, origin }),
        body: "{}",
      });
      expect(answer.status, origin).toBe(403);
    }
    // localhost works when the Host is localhost too.
    const viaLocalhost = await send(s.port, {
      method: "POST",
      path: "/api/workspaces.list",
      headers: apiHeaders(s, {
        ...auth,
        host: `localhost:${s.port}`,
        origin: `http://localhost:${s.port}`,
      }),
      body: "{}",
    });
    expect(viaLocalhost.status).toBe(200);
  });

  it("refuses a Sec-Fetch-Site other than same-origin, and takes none", async () => {
    const s = await start();
    const session = await sessionFor(s);
    const auth = { authorization: `Bearer ${session}` };
    for (const site of ["cross-site", "same-site", "none"]) {
      const answer = await send(s.port, {
        method: "POST",
        path: "/api/workspaces.list",
        headers: apiHeaders(s, { ...auth, "sec-fetch-site": site }),
        body: "{}",
      });
      expect(answer.status, site).toBe(403);
    }
    const { "sec-fetch-site": _site, ...plain } = apiHeaders(s, auth);
    const absent = await send(s.port, {
      method: "POST",
      path: "/api/workspaces.list",
      headers: plain,
      body: "{}",
    });
    expect(absent.status).toBe(200);
    expect(api.calls.map((c) => c.route)).toEqual(["workspaces.list"]);
  });

  it("takes application/json only", async () => {
    const s = await start();
    const session = await sessionFor(s);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await send(s.port, {
        method: "POST",
        path: "/api/workspaces.list",
        headers: apiHeaders(s, { authorization: `Bearer ${session}`, "content-type": type }),
        body: "{}",
      });
      expect(answer.status, type).toBe(415);
    }
    const charset = await send(s.port, {
      method: "POST",
      path: "/api/workspaces.list",
      headers: apiHeaders(s, {
        authorization: `Bearer ${session}`,
        "content-type": "application/json; charset=utf-8",
      }),
      body: "{}",
    });
    expect(charset.status).toBe(200);
  });

  it("requires a valid bearer session on every route but session", async () => {
    const s = await start();
    const session = await sessionFor(s);
    const cases: Array<[string, Record<string, string>]> = [
      ["missing", {}],
      ["wrong", { authorization: "Bearer not-a-session" }],
      ["a launch token", { authorization: `Bearer ${launchToken(s)}` }],
      ["the control token", { authorization: "Bearer control-token" }],
      ["not a bearer", { authorization: `Basic ${session}` }],
      ["lower-case scheme", { authorization: `bearer ${session}` }],
    ];
    for (const [label, headers] of cases) {
      const answer = await send(s.port, {
        method: "POST",
        path: "/api/workspaces.list",
        headers: apiHeaders(s, headers),
        body: "{}",
      });
      expect(answer.status, label).toBe(401);
      expect(answer.json.error?.code).toBe("unauthorized");
    }
    expect(api.calls).toEqual([]);
    expect((await call(s, "workspaces.list", session)).status).toBe(200);
  });

  it("trades a launch token once, and not after it expired", async () => {
    const s = await start();
    const token = launchToken(s);
    const exchange = (launch: unknown) =>
      send(s.port, {
        method: "POST",
        path: "/api/session",
        headers: apiHeaders(s),
        body: JSON.stringify({ launchToken: launch }),
      });
    const first = await exchange(token);
    expect(first.status).toBe(200);
    expect(first.json.sessionToken).toMatch(/^[\w-]{43}$/);
    expect(new Date(first.json.expiresAt as string).getTime()).toBe(now + 12 * 60 * 60 * 1000);
    const again = await exchange(token);
    expect(again.status).toBe(401);
    expect(again.json.error?.code).toBe("unauthorized");

    const late = launchToken(s);
    now += LAUNCH_TOKEN_TTL_MS;
    expect((await exchange(late)).status).toBe(401);
    expect((await exchange(undefined)).status).toBe(401);
    expect((await exchange(42)).status).toBe(401);
    // The session token works until it expires.
    expect((await call(s, "workspaces.list", first.json.sessionToken as string)).status).toBe(200);
    now += 12 * 60 * 60 * 1000;
    expect((await call(s, "workspaces.list", first.json.sessionToken as string)).status).toBe(401);
  });

  it("checks the Origin of the session exchange too", async () => {
    const s = await start();
    const answer = await send(s.port, {
      method: "POST",
      path: "/api/session",
      headers: apiHeaders(s, { origin: "http://evil.example" }),
      body: JSON.stringify({ launchToken: launchToken(s) }),
    });
    expect(answer.status).toBe(403);
  });

  it("caps the body at 256 KB, declared or not", async () => {
    const s = await start();
    const session = await sessionFor(s);
    const big = JSON.stringify({ workspaceId: "x".repeat(256 * 1024) });
    const declared = await send(s.port, {
      method: "POST",
      path: "/api/knowledge.create",
      headers: apiHeaders(s, { authorization: `Bearer ${session}` }),
      body: big,
    });
    expect(declared.status).toBe(413);
    expect(declared.json.error?.code).toBe("payload_too_large");
    const streamed = await send(s.port, {
      method: "POST",
      path: "/api/knowledge.create",
      headers: apiHeaders(s, { authorization: `Bearer ${session}` }),
      body: big,
      chunked: true,
    });
    expect(streamed.status).toBe(413);
    expect(api.calls).toEqual([]);
    // Just under the cap is read.
    const fits = JSON.stringify({ q: "x".repeat(256 * 1024 - 20) });
    expect((await call(s, "knowledge.search", session, JSON.parse(fits))).status).toBe(200);
  });

  it("answers 400 to a body that is not a JSON object, and 404 to an unknown route", async () => {
    const s = await start();
    const session = await sessionFor(s);
    const raw = (body: string) =>
      send(s.port, {
        method: "POST",
        path: "/api/workspaces.list",
        headers: apiHeaders(s, { authorization: `Bearer ${session}` }),
        body,
      });
    for (const body of ["{", "not json", "[]", "null", '"text"', "7"]) {
      const answer = await raw(body);
      expect(answer.status, body).toBe(400);
      expect(answer.json.error?.code).toBe("bad_request");
    }
    for (const route of ["nope", "knowledge.purge", "", "session/extra"]) {
      const answer = await call(s, route, session);
      expect(answer.status, route).toBe(404);
      expect(answer.json.error?.code).toBe("not_found");
    }
    expect(api.calls).toEqual([]);
  });

  it("answers a route's refusal and failure as LocalUiError bodies", async () => {
    const s = await start();
    const session = await sessionFor(s);
    api.answer = async (route) => {
      if (route === "knowledge.update") throw new LocalUiApiError("conflict", "stale");
      throw new Error("boom");
    };
    const conflict = await call(s, "knowledge.update", session);
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ error: { code: "conflict", message: "stale" } });
    expectSecurityHeaders(conflict);
    expect(conflict.headers["cache-control"]).toBe("no-store");
    const failure = await call(s, "tree.get", session);
    expect(failure.status).toBe(500);
    expect(failure.json.error?.code).toBe("internal");
  });

  it("gives a route 15 s (here shorter), and a body the same", async () => {
    const s = await start({ requestTimeoutMs: 300 });
    const session = await sessionFor(s);
    api.answer = () => new Promise(() => {});
    const slow = await call(s, "workspaces.list", session);
    expect(slow.status).toBe(504);
    expect(slow.json.error?.code).toBe("timeout");

    // A body that never finishes arriving.
    const stalled = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: s.port,
          method: "POST",
          path: "/api/workspaces.list",
          headers: {
            ...apiHeaders(s, { authorization: `Bearer ${session}` }),
            "content-length": "100",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write("{");
    });
    expect(stalled).toBe(408);
  });
});

describe("pathrule ui server: control", () => {
  const control = (s: LocalUiServer, headers: Record<string, string>, method = "POST") =>
    send(s.port, {
      method,
      path: "/control/launch",
      headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers },
      body: method === "POST" ? "{}" : undefined,
    });

  it("hands this user's CLI a fresh launch link, and nothing to a browser", async () => {
    const s = await start();
    const ok = await control(s, { authorization: "Bearer control-token" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ port: s.port, pid: process.pid });
    const link = new URL(ok.json.launchUrl as string);
    expect(link.origin).toBe(s.origin);
    // The link it handed out opens a session.
    const exchanged = await send(s.port, {
      method: "POST",
      path: "/api/session",
      headers: apiHeaders(s),
      body: JSON.stringify({ launchToken: link.hash.slice("#launch=".length) }),
    });
    expect(exchanged.status).toBe(200);

    expect(
      (await control(s, { authorization: "Bearer control-token", origin: s.origin })).status,
    ).toBe(403);
    expect(
      (await control(s, { authorization: "Bearer control-token", "sec-fetch-site": "same-origin" }))
        .status,
    ).toBe(403);
    expect((await control(s, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await control(s, {})).status).toBe(401);
    expect((await control(s, { authorization: "Bearer control-token" }, "GET")).status).toBe(405);
  });

  it("does not exist without a control token", async () => {
    const s = await start({ controlToken: undefined });
    expect((await control(s, { authorization: "Bearer control-token" })).status).toBe(404);
  });
});

describe("pathrule ui server: the console's files", () => {
  const get = (s: LocalUiServer, path: string, method = "GET") =>
    send(s.port, { method, path, headers: { host: `127.0.0.1:${s.port}` } });

  it("serves index.html uncached and hashed assets for a year", async () => {
    const s = await start();
    const index = await get(s, "/");
    expect(index.status).toBe(200);
    expect(index.text).toContain("<title>console</title>");
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.headers["cache-control"]).toBe("no-store");
    expectSecurityHeaders(index, metaNonce(index.text));
    const asset = await get(s, "/assets/app-1234.js");
    expect(asset.status).toBe(200);
    expect(asset.text).toBe("console.log('app');");
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(asset);
    const head = await get(s, "/assets/app-1234.js", "HEAD");
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
  });

  it("gives every index.html answer its own style nonce, in the policy and the page", async () => {
    const s = await start();
    expect(UI_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const first = await get(s, "/");
    const second = await get(s, "/workspaces/abc");
    const nonces = [first, second].map((answer) => {
      expect(answer.text).not.toContain("__PR_STYLE_NONCE__");
      const nonce = metaNonce(answer.text);
      expect(Buffer.from(nonce, "base64").length).toBeGreaterThanOrEqual(16);
      // The header allows exactly the nonce the page carries; nothing else in it changed.
      expect(answer.headers["content-security-policy"]).toBe(contentSecurityPolicy(nonce));
      expect(answer.headers["content-security-policy"]).toContain(
        `style-src 'self' 'nonce-${nonce}';`,
      );
      expect(Number(answer.headers["content-length"])).toBe(Buffer.byteLength(answer.text));
      return nonce;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
    // Only index.html gets one.
    const asset = await get(s, "/assets/app-1234.js");
    expect(asset.headers["content-security-policy"]).toBe(UI_CONTENT_SECURITY_POLICY);
    const head = await get(s, "/", "HEAD");
    expect(head.text).toBe("");
    expect(head.headers["content-security-policy"]).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("falls back to index.html for a console route, not for a missing asset", async () => {
    const s = await start();
    const route = await get(s, "/workspaces/abc/memories?x=1");
    expect(route.status).toBe(200);
    expect(route.text).toContain("<title>console</title>");
    expect(route.headers["cache-control"]).toBe("no-store");
    expect((await get(s, "/assets/missing-9.js")).status).toBe(404);
  });

  it("never serves a file outside the console's folder", async () => {
    const s = await start();
    symlinkSync(join(dir, "secret.txt"), join(assets, "link.txt"));
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%2fsecret.txt",
      "/link.txt",
    ]) {
      const answer = await get(s, path);
      expect(answer.status, path).toBe(403);
      expect(answer.text).not.toContain("TOP SECRET");
    }
    for (const path of ["/%E0%A4%A", "/%00secret.txt", "/assets\\..\\..\\secret.txt"]) {
      const answer = await get(s, path);
      expect(answer.status, path).toBe(400);
      expect(answer.text).not.toContain("TOP SECRET");
    }
  });

  it("answers GET and HEAD only", async () => {
    const s = await start();
    const post = await send(s.port, {
      method: "POST",
      path: "/",
      headers: { host: `127.0.0.1:${s.port}` },
      body: "{}",
    });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it("says how to build the console while it is not built", async () => {
    const s = await start({ assetsDir: null });
    for (const path of ["/", "/workspaces/abc"]) {
      const page = await get(s, path);
      expect(page.status).toBe(200);
      expect(page.text).toContain(UI_ASSETS_BUILD_COMMAND);
      expect(page.text).not.toMatch(/<script|<style|style=/);
      expect(page.headers["cache-control"]).toBe("no-store");
      expectSecurityHeaders(page);
    }
  });
});
