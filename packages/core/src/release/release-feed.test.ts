// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReleaseManifest } from "@pathrule/protocol/release-manifest.js";

import { releaseKeyId, signReleaseManifest, type ReleaseSigningKey } from "./manifest-signature.js";
import {
  cachedReleaseManifest,
  fetchReleaseManifest,
  releaseManifestUrl,
  updateCheckDue,
} from "./release-feed.js";
import { activeRuntimeSessions, registerRuntimeSession } from "./runtime-sessions.js";
import { readUpdatePreference, readUpdateState, writeUpdatePreference } from "./update-state.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEYS: ReleaseSigningKey[] = [{ keyid: releaseKeyId(publicKeyPem), publicKeyPem }];
const NOW = new Date("2026-10-13T12:00:00Z");

function manifest(sequence: number, version = "1.0.1"): ReleaseManifest {
  return {
    schema_version: 1,
    sequence,
    generated_at: "2026-10-13T10:00:00Z",
    expires_at: "2027-04-11T10:00:00Z",
    components: {
      cli: {
        restart: "new-session",
        channels: {
          npm: {
            latest: {
              version,
              published_at: "2026-10-13T09:00:00Z",
              verified_at: "2026-10-13T09:05:00Z",
            },
          },
        },
      },
    },
  };
}

function respond(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as typeof fetch;
}

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-feed-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const options = (fetchImpl: typeof fetch) => ({
  env,
  fetchImpl,
  now: () => NOW,
  userAgent: "pathrule-cli/1.0.0",
  keys: KEYS,
});

describe("fetching the release manifest", () => {
  it("verifies, remembers and serves it from disk afterwards", async () => {
    const body = JSON.stringify(signReleaseManifest(manifest(3), privateKeyPem));
    const result = await fetchReleaseManifest(options(respond(body)));
    expect(result).toMatchObject({ ok: true, source: "network" });
    const state = readUpdateState(env);
    expect(state.highest_sequence).toBe(3);
    expect(state.last_error).toBeUndefined();
    expect(cachedReleaseManifest(env, { now: NOW, keys: KEYS })?.manifest.sequence).toBe(3);
    // The state is the person's own: readable only by them.
    if (process.platform !== "win32") {
      expect(statSync(join(home, "updates", "state.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("sends no credentials and names only the product", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await fetchReleaseManifest(options(fetchImpl));
    expect(seen?.credentials).toBe("omit");
    expect(seen?.headers).toEqual({
      accept: "application/json",
      "user-agent": "pathrule-cli/1.0.0",
    });
  });

  it("is quiet offline and keeps the last verified manifest", async () => {
    await fetchReleaseManifest(
      options(respond(JSON.stringify(signReleaseManifest(manifest(3), privateKeyPem)))),
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await fetchReleaseManifest(options(offline));
    expect(result).toMatchObject({ ok: false, reason: "offline" });
    expect(result.ok === false && result.cached?.manifest.sequence).toBe(3);
    expect(readUpdateState(env).last_error).toBe("offline");
  });

  it("times out instead of hanging", async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const started = Date.now();
    const result = await fetchReleaseManifest({ ...options(hang), timeoutMs: 50 });
    expect(result).toMatchObject({ ok: false, reason: "offline" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a server error, an oversized body and a non-JSON body", async () => {
    expect(await fetchReleaseManifest(options(respond("x", { status: 503 })))).toMatchObject({
      ok: false,
      reason: "http_error",
    });
    expect(await fetchReleaseManifest(options(respond("x".repeat(600 * 1024))))).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    expect(
      await fetchReleaseManifest(options(respond("<html>captive portal</html>"))),
    ).toMatchObject({
      ok: false,
      reason: "not_json",
    });
  });

  it("refuses a manipulated manifest and keeps the verified one", async () => {
    await fetchReleaseManifest(
      options(respond(JSON.stringify(signReleaseManifest(manifest(3), privateKeyPem)))),
    );
    const tampered = JSON.parse(JSON.stringify(signReleaseManifest(manifest(4), privateKeyPem)));
    tampered.signed.components.cli.channels.npm.latest.version = "6.6.6";
    const result = await fetchReleaseManifest(options(respond(JSON.stringify(tampered))));
    expect(result).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(readUpdateState(env).highest_sequence).toBe(3);
    expect(
      cachedReleaseManifest(env, { now: NOW, keys: KEYS })?.manifest.components.cli?.channels.npm
        ?.latest?.version,
    ).toBe("1.0.1");
  });

  it("refuses an older manifest served after a newer one (rollback)", async () => {
    await fetchReleaseManifest(
      options(respond(JSON.stringify(signReleaseManifest(manifest(9, "1.2.0"), privateKeyPem)))),
    );
    const replay = JSON.stringify(signReleaseManifest(manifest(8, "1.1.0"), privateKeyPem));
    expect(await fetchReleaseManifest(options(respond(replay)))).toMatchObject({
      ok: false,
      reason: "rollback",
    });
    expect(cachedReleaseManifest(env, { now: NOW, keys: KEYS })?.manifest.sequence).toBe(9);
  });

  it("does not trust a cached manifest that was edited on disk", async () => {
    await fetchReleaseManifest(
      options(respond(JSON.stringify(signReleaseManifest(manifest(3), privateKeyPem)))),
    );
    const path = join(home, "updates", "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.envelope.signed.components.cli.channels.npm.latest.version = "9.0.0";
    writeFileSync(path, JSON.stringify(state));
    expect(cachedReleaseManifest(env, { now: NOW, keys: KEYS })).toBeNull();
  });

  it("stops believing a cached manifest once it expires", async () => {
    await fetchReleaseManifest(
      options(respond(JSON.stringify(signReleaseManifest(manifest(3), privateKeyPem)))),
    );
    expect(
      cachedReleaseManifest(env, { now: new Date("2027-06-01T00:00:00Z"), keys: KEYS }),
    ).toBeNull();
  });
});

describe("when to check", () => {
  it("checks once a day, retries a failure after an hour", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(updateCheckDue({ schema: 1, highest_sequence: 0 }, NOW)).toBe(true);
    expect(
      updateCheckDue({ schema: 1, highest_sequence: 1, last_check_at: at(3_600_000) }, NOW),
    ).toBe(false);
    expect(
      updateCheckDue({ schema: 1, highest_sequence: 1, last_check_at: at(25 * 3_600_000) }, NOW),
    ).toBe(true);
    expect(
      updateCheckDue(
        { schema: 1, highest_sequence: 0, last_attempt_at: at(600_000), last_error: "offline" },
        NOW,
      ),
    ).toBe(false);
    expect(
      updateCheckDue(
        {
          schema: 1,
          highest_sequence: 0,
          last_attempt_at: at(2 * 3_600_000),
          last_error: "offline",
        },
        NOW,
      ),
    ).toBe(true);
    // A clock moved backwards does not freeze checks forever.
    expect(
      updateCheckDue(
        { schema: 1, highest_sequence: 1, last_check_at: "2030-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBe(true);
  });

  it("only overrides the URL with https or a loopback test server", () => {
    expect(releaseManifestUrl({})).toBe("https://releases.pathrule.io/v1/manifest.json");
    expect(
      releaseManifestUrl({ PATHRULE_RELEASE_MANIFEST_URL: "https://staging.example/m.json" }),
    ).toBe("https://staging.example/m.json");
    expect(releaseManifestUrl({ PATHRULE_RELEASE_MANIFEST_URL: "http://127.0.0.1:9/m.json" })).toBe(
      "http://127.0.0.1:9/m.json",
    );
    expect(
      releaseManifestUrl({ PATHRULE_RELEASE_MANIFEST_URL: "http://evil.example/m.json" }),
    ).toBe("https://releases.pathrule.io/v1/manifest.json");
  });
});

describe("update preference without an account", () => {
  it("round-trips and ignores anything else", () => {
    expect(readUpdatePreference(env)).toBeNull();
    writeUpdatePreference(env, "manual");
    expect(readUpdatePreference(env)).toBe("manual");
    writeFileSync(
      join(home, "updates", "preferences.json"),
      JSON.stringify({ update_policy: "yolo" }),
    );
    expect(readUpdatePreference(env)).toBeNull();
  });
});

describe("runtime session leases", () => {
  it("lists other live sessions and drops the leases of exited ones", () => {
    const dir = join(home, "updates", "sessions");
    mkdirSync(dir, { recursive: true });
    const lease = (pid: number) => ({
      pid,
      kind: "mcp",
      version: "1.0.0",
      started_at: NOW.toISOString(),
    });
    writeFileSync(join(dir, "101-mcp.json"), JSON.stringify(lease(101)));
    writeFileSync(join(dir, "202-mcp.json"), JSON.stringify(lease(202)));
    const alive = (pid: number) => pid === 101;
    expect(activeRuntimeSessions(env, alive).map((s) => s.pid)).toEqual([101]);
    expect(() => statSync(join(dir, "202-mcp.json"))).toThrow();
  });

  it("does not count the caller's own process, and releases on demand", () => {
    const release = registerRuntimeSession(env, { kind: "mcp", version: "1.0.0" });
    expect(statSync(join(home, "updates", "sessions", `${process.pid}-mcp.json`)).isFile()).toBe(
      true,
    );
    expect(activeRuntimeSessions(env)).toEqual([]);
    release();
    expect(() => statSync(join(home, "updates", "sessions", `${process.pid}-mcp.json`))).toThrow();
  });
});
