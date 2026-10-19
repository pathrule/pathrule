// SPDX-License-Identifier: Apache-2.0
// The native session's lifecycle on this machine: persisted 0600 apart from credentials.json,
// the person recorded as the native owner and nothing else written down, refreshed and rotated,
// signed out on expiry, revocation and logout, an account switch taking the previous person's
// private hook entries with it, and an outage changing nothing.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAccountOwners } from "@pathrule/core/storage/account-owners.js";

import {
  loginNativeDevice,
  nativeOrigin,
  nativeSessionFile,
  nativeTransportSource,
  readNativeSession,
  refreshNativeSession,
  signOutNative,
  writeNativeSession,
} from "./credentials.js";

const BASE = "https://native.example.test";
const TOKEN = "tok_abc.def";
let home: string;
let env: NodeJS.ProcessEnv;
let clock: Date;
const now = () => clock;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-native-session-"));
  env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
  clock = new Date("2026-10-09T12:00:00.000Z");
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const inDays = (days: number) => new Date(clock.getTime() + days * 86_400_000).toISOString();
const deps = (extra: Record<string, unknown> = {}) => ({ env, now, ...extra });

/** A hook index holding one person's private entries beside project knowledge. */
function indexOwnedBy(owner: string): string {
  const dir = join(home, "cache", "ws-1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hook-index.json");
  writeFileSync(
    path,
    JSON.stringify({
      workspace_id: "ws-1",
      path_memories: { "/": ["m-1"] },
      user_preferences: [{ id: "p", line: "l", terms: [], always: true }],
      personal_owner: owner,
      intelligence_profiles: { owner, version: "v", block: "B", ids: [] },
    }),
  );
  return path;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("native session persistence", () => {
  it("keeps the session in its own 0600 file and records only the person as the owner", async () => {
    await writeNativeSession(
      { base_url: `${BASE}/some/path`, user_id: "native-a", token: TOKEN, expires_at: inDays(7) },
      deps(),
    );
    if (process.platform !== "win32") expect(statSync(nativeSessionFile(env)).mode & 0o777).toBe(0o600);
    expect(await readNativeSession(deps())).toMatchObject({
      base_url: BASE,
      user_id: "native-a",
      token: TOKEN,
    });
    expect(await readAccountOwners(env)).toMatchObject({ native: { user_id: "native-a" } });
    const owners = readFileSync(join(home, "account-owners.json"), "utf8");
    expect(owners).not.toContain(TOKEN);
    expect(existsSync(join(home, "credentials.json"))).toBe(false);
  });

  it("reads an expired session as no session", async () => {
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: TOKEN, expires_at: inDays(1) },
      deps(),
    );
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    expect(await readNativeSession(deps())).toBeNull();
  });

  it("refuses a token for a plain-http remote origin", () => {
    expect(() => nativeOrigin("http://native.example.test")).toThrow(/https/);
    expect(nativeOrigin("http://127.0.0.1:8787/x")).toBe("http://127.0.0.1:8787");
  });

  it("an account switch removes the previous person's private hook entries and keeps project knowledge", async () => {
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: TOKEN, expires_at: inDays(7) },
      deps(),
    );
    const path = indexOwnedBy("native-a");
    expect(
      await writeNativeSession(
        { base_url: BASE, user_id: "native-b", token: "tok_b", expires_at: inDays(7) },
        deps(),
      ),
    ).toBe("native-a");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      workspace_id: "ws-1",
      path_memories: { "/": ["m-1"] },
    });
    expect(await readAccountOwners(env)).toMatchObject({ native: { user_id: "native-b" } });
  });
});

describe("native transport", () => {
  it("returns the same snapshot until the session changes, then null once it is gone or expired", async () => {
    const source = nativeTransportSource(
      deps({ deploymentHeaders: () => ({ "x-shadow-key": "k" }) }),
    );
    expect(await source()).toBeNull();
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: TOKEN, expires_at: inDays(2) },
      deps(),
    );
    const first = await source();
    expect(first).toBe(await source());
    expect(await first!.headers()).toEqual({
      "x-shadow-key": "k",
      authorization: `Bearer ${TOKEN}`,
    });
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: "tok_rotated", expires_at: inDays(2) },
      deps(),
    );
    const rotated = await source();
    expect(rotated).not.toBe(first);
    indexOwnedBy("native-a");
    clock = new Date(clock.getTime() + 3 * 86_400_000);
    expect(await source()).toBeNull();
    expect(existsSync(nativeSessionFile(env))).toBe(false);
    expect(await readAccountOwners(env)).toEqual({});
  });
});

describe("refresh, revocation and sign-out", () => {
  beforeEach(async () => {
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: TOKEN, expires_at: inDays(0.5) },
      deps(),
    );
  });

  it("writes the extended expiry and a rotated token", async () => {
    const fetch = vi.fn(async () =>
      respond(
        200,
        { session: { expiresAt: inDays(7) }, user: { id: "native-a" } },
        { "set-auth-token": "tok_new" },
      ),
    );
    expect(await refreshNativeSession(deps({ fetch }))).toBe("active");
    expect(fetch).toHaveBeenCalledWith(
      new URL("/api/auth/get-session", BASE),
      expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(await readNativeSession(deps())).toMatchObject({
      token: "tok_new",
      expires_at: inDays(7),
    });
  });

  it("signs out a session the server revoked, with the person's private entries", async () => {
    const path = indexOwnedBy("native-a");
    expect(
      await refreshNativeSession(
        deps({ fetch: async () => respond(401, { error: "unauthorized" }) }),
      ),
    ).toBe("revoked");
    expect(await readNativeSession(deps())).toBeNull();
    expect(await readAccountOwners(env)).toEqual({});
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("user_preferences");
    // Better Auth answers an unknown token with an empty session rather than 401.
    await writeNativeSession(
      { base_url: BASE, user_id: "native-a", token: TOKEN, expires_at: inDays(2) },
      deps(),
    );
    expect(await refreshNativeSession(deps({ fetch: async () => respond(200, null) }))).toBe(
      "revoked",
    );
  });

  it("changes nothing when the server cannot be reached", async () => {
    const fetch = async () => {
      throw new Error("offline");
    };
    expect(await refreshNativeSession(deps({ fetch }))).toBe("unreachable");
    expect(
      await refreshNativeSession(deps({ fetch: async () => respond(503, { error: "down" }) })),
    ).toBe("unreachable");
    expect(await readNativeSession(deps())).toMatchObject({ user_id: "native-a", token: TOKEN });
  });

  it("asks the server to end the session and signs out locally whatever it answers", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await signOutNative(deps({ fetch, deploymentHeaders: () => ({ "x-shadow-key": "k" }) })),
    ).toBe("native-a");
    expect(fetch).toHaveBeenCalledWith(
      new URL("/api/auth/sign-out", BASE),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}`, "x-shadow-key": "k" }),
      }),
    );
    expect(existsSync(nativeSessionFile(env))).toBe(false);
    expect(await readAccountOwners(env)).toEqual({});
  });
});

describe("device-code login", () => {
  it("waits through pending and slow_down, then keeps the confirmed session", async () => {
    const answers = [
      respond(200, {
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: `${BASE}/device`,
        interval: 1,
        expires_in: 600,
      }),
      respond(400, { error: "authorization_pending" }),
      respond(400, { error: "slow_down" }),
      respond(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 604800 }),
      respond(200, { session: { expiresAt: inDays(7) }, user: { id: "native-a" } }),
    ];
    const fetch = vi.fn(async () => answers.shift()!);
    const shown: unknown[] = [];
    const out = await loginNativeDevice(
      { baseUrl: BASE, clientId: "pathrule-cli", onCode: (p) => void shown.push(p) },
      deps({ fetch, sleep: async () => undefined }),
    );
    expect(out).toEqual({ userId: "native-a", expiresAt: inDays(7), replaced: null });
    expect(shown).toEqual([{ user_code: "ABCD-EFGH", verification_uri: `${BASE}/device` }]);
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
    expect(await readNativeSession(deps())).toMatchObject({ user_id: "native-a", token: TOKEN });
  });

  it("stops on a denied sign-in and keeps nothing", async () => {
    const answers = [
      respond(200, {
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: `${BASE}/device`,
        interval: 1,
        expires_in: 600,
      }),
      respond(400, { error: "access_denied" }),
    ];
    await expect(
      loginNativeDevice(
        { baseUrl: BASE, clientId: "pathrule-cli", onCode: () => undefined },
        deps({ fetch: async () => answers.shift()!, sleep: async () => undefined }),
      ),
    ).rejects.toThrow(/denied/);
    expect(await readNativeSession(deps())).toBeNull();
  });
});
