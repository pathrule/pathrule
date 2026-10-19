// SPDX-License-Identifier: Apache-2.0
// Who may reach the host, and what an envelope must be. Every refusal happens before a method runs:
// the probe method below counts its calls.
import { connect } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import {
  envelope,
  goodHeaders,
  rawRequest,
  scratchHome,
  type ScratchHome,
} from "./__fixtures__/helpers.js";
import { startHost, type RunningHost } from "./host.js";
import { bearerMatches, isLoopbackHost } from "./rpc-server.js";

let home: ScratchHome;
let host: RunningHost;
let probeCalls = 0;

beforeEach(async () => {
  home = scratchHome();
  probeCalls = 0;
  host = await startHost({
    env: home.env,
    maxBodyBytes: 1024,
    requestTimeoutMs: 200,
    plugins: [
      {
        name: "probe",
        contract: HOST_PLUGIN_CONTRACT,
        sharedPackages: [],
        activate(ctx) {
          ctx.registerMethod("count", () => {
            probeCalls += 1;
            return { calls: probeCalls };
          });
          ctx.registerMethod("hang", (_params, { signal }) => {
            return new Promise((resolve) =>
              signal.addEventListener("abort", () => resolve("aborted")),
            );
          });
          ctx.registerMethod("fail", () => {
            throw new Error("the method broke");
          });
        },
      },
    ],
  });
});

afterEach(async () => {
  await host.stop();
  home.remove();
});

const port = () => host.record.port;
const token = () => host.record.token;

describe("access", () => {
  it("serves a well-formed request with the token", async () => {
    const res = await rawRequest({
      port: port(),
      headers: goodHeaders(port(), token()),
      body: envelope("probe.count"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 1, result: { calls: 1 } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("accepts localhost as the Host name", async () => {
    const headers = { ...goodHeaders(port(), token()), host: `localhost:${port()}` };
    const res = await rawRequest({ port: port(), headers, body: envelope("probe.count") });
    expect(res.status).toBe(200);
  });

  it.each([
    ["an Origin header (a browser)", { origin: "https://example.com" }, 403, "forbidden_origin"],
    ["even a loopback Origin", { origin: "http://127.0.0.1" }, 403, "forbidden_origin"],
    ["a foreign Host (DNS rebinding)", { host: "evil.example:80" }, 403, "forbidden_host"],
    ["the right name on another port", { host: "127.0.0.1:1" }, 403, "forbidden_host"],
    ["no token", { authorization: "" }, 401, "unauthorized"],
    ["a wrong token", { authorization: "Bearer not-the-token" }, 401, "unauthorized"],
    ["the token without the scheme", { authorization: "TOKEN" }, 401, "unauthorized"],
    ["a non-JSON content type", { "content-type": "text/plain" }, 415, "unsupported_media_type"],
  ])(
    "refuses %s before any method runs",
    async (_what, override: Record<string, string>, status, code) => {
      const headers: Record<string, string> = { ...goodHeaders(port(), token()), ...override };
      if (override.authorization === "TOKEN") headers.authorization = token();
      if (override.authorization === "") delete headers.authorization;
      const res = await rawRequest({ port: port(), headers, body: envelope("probe.count") });
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, error: { code } });
      expect(probeCalls).toBe(0);
    },
  );

  it("checks the browser signals before the token, so a page learns nothing about it", async () => {
    const res = await rawRequest({
      port: port(),
      headers: { host: `127.0.0.1:${port()}`, origin: "https://example.com" },
      body: envelope("probe.count"),
    });
    expect(res.body).toMatchObject({ error: { code: "forbidden_origin" } });
  });

  it("serves only POST /rpc", async () => {
    const other = await rawRequest({
      port: port(),
      path: "/",
      headers: goodHeaders(port(), token()),
      body: envelope("probe.count"),
    });
    expect(other.status).toBe(404);
    const get = await rawRequest({
      port: port(),
      method: "GET",
      headers: goodHeaders(port(), token()),
    });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect(probeCalls).toBe(0);
  });

  it("compares tokens by content only", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches("Bearer abc", "")).toBe(false);
    expect(bearerMatches(undefined, "abc")).toBe(false);
    expect(isLoopbackHost("LOCALHOST:5", 5)).toBe(true);
    expect(isLoopbackHost("[::1]:5", 5)).toBe(false);
  });
});

describe("the envelope", () => {
  const send = (body: string, extra: Record<string, string> = {}) =>
    rawRequest({ port: port(), headers: { ...goodHeaders(port(), token()), ...extra }, body });

  it("refuses a body over the limit, declared or streamed", async () => {
    const big = JSON.stringify({
      v: 1,
      id: 1,
      method: "probe.count",
      params: { pad: "x".repeat(2048) },
    });
    const declared = await send(big);
    expect(declared.status).toBe(413);
    expect(declared.body).toMatchObject({ error: { code: "payload_too_large" } });
    const streamed = await send(big, { "transfer-encoding": "chunked" });
    expect(streamed.status).toBe(413);
    expect(probeCalls).toBe(0);
  });

  it("cuts off a client that keeps sending past the limit", async () => {
    const socket = connect(port(), "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    let answer = "";
    socket.on("data", (chunk: Buffer) => (answer += chunk.toString()));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    const head = Object.entries(goodHeaders(port(), token()))
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    socket.write(`POST /rpc HTTP/1.1\r\n${head}\r\ntransfer-encoding: chunked\r\n\r\n`);
    const chunk = "x".repeat(512);
    const pump = setInterval(() => {
      if (!socket.destroyed) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    }, 20);
    const began = Date.now();
    await closed;
    clearInterval(pump);
    expect(Date.now() - began).toBeLessThan(5_000);
    // The server answers 413 before it cuts the client off. Windows resets a connection whose peer
    // is still sending and drops what the client had not read yet, so only POSIX can see the answer.
    if (process.platform !== "win32") {
      expect(answer).toContain("413");
      expect(answer).toContain("payload_too_large");
    }
    expect(probeCalls).toBe(0);
  }, 10_000);

  it.each([
    ["not JSON", "{nope"],
    ["not an object", "[1,2]"],
    ["no method", JSON.stringify({ v: 1, id: 1 })],
    ["no id", JSON.stringify({ v: 1, method: "probe.count" })],
    ["an object id", JSON.stringify({ v: 1, id: {}, method: "probe.count" })],
  ])("refuses an envelope that is %s", async (_what, body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(probeCalls).toBe(0);
  });

  it("refuses another RPC version and names both", async () => {
    const res = await send(envelope("probe.count", {}, 2));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ id: 1, error: { code: "rpc_version_mismatch" } });
    expect(JSON.stringify(res.body)).toContain("speaks host RPC 2; this host speaks 1");
    expect(probeCalls).toBe(0);
  });

  it("answers an unknown method, a failing method and a slow one with their codes", async () => {
    expect((await send(envelope("probe.nothing"))).body).toMatchObject({
      error: { code: "method_not_found" },
    });
    const failed = await send(envelope("probe.fail"));
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({
      error: { code: "internal_error", message: "the method broke" },
    });
    const slow = await send(envelope("probe.hang"));
    expect(slow.status).toBe(504);
    expect(slow.body).toMatchObject({ error: { code: "timeout" } });
  });

  it("validates the params of its own methods", async () => {
    const res = await send(envelope("workspace.resolve", { cwd: "relative/path" }));
    expect(res.body).toMatchObject({ error: { code: "invalid_params" } });
  });
});
