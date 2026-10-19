// SPDX-License-Identifier: Apache-2.0
// The account commands when the run names Pathrule Cloud: Better Auth's device flow, the session in
// its own file, sign-out on the server, and no call to the legacy backend.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli as runOpenCli, type CliRuntime } from "@pathrule/cli/run.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nativeCloudConfig } from "../native/config.js";
import { nativeSessionFile } from "../native/credentials.js";
import { cloudCliPlugin } from "./plugin.js";

const BASE = "https://cloud.example.test";
const TOKEN = "native-session-token.signature";

class MemoryWriter {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

let root: string;
let calls: { url: string; method: string; authorization: string | null; body: unknown }[];
let signedIn: boolean;

/** Pathrule Cloud's auth endpoints as Better Auth answers them. */
const cloud = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  calls.push({
    url,
    method: init?.method ?? "GET",
    authorization: headers.get("authorization"),
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  if (url === `${BASE}/api/auth/device/code`)
    return json({
      device_code: "device-1",
      user_code: "WXYZ2345",
      verification_uri: `${BASE}/device`,
      verification_uri_complete: `${BASE}/device?user_code=WXYZ2345`,
      interval: 1,
      expires_in: 600,
    });
  if (url === `${BASE}/api/auth/device/token`) {
    signedIn = true;
    return json({ access_token: TOKEN, token_type: "Bearer" });
  }
  if (url === `${BASE}/api/auth/get-session`)
    return signedIn && headers.get("authorization") === `Bearer ${TOKEN}`
      ? json({
          session: { expiresAt: "2026-10-20T00:00:00.000Z" },
          user: { id: "user-1", email: "person@example.invalid" },
        })
      : json(null, 401);
  if (url === `${BASE}/api/auth/sign-out`) {
    signedIn = false;
    return json({ success: true });
  }
  return json({ error: "not a Pathrule Cloud route" }, 404);
}) as typeof fetch;

function runtime(
  stdout = new MemoryWriter(),
  stderr = new MemoryWriter(),
  opened: string[] = [],
): CliRuntime {
  return {
    cwd: "/repo",
    env: {
      PATHRULE_HOME: root,
      PATHRULE_DAEMON_AUTOSTART: "0",
      PATHRULE_NATIVE_CLOUD_URL: BASE,
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
    },
    stdout,
    stderr,
    fetch: cloud,
    sleep: async () => {},
    openUrl: async (url) => void opened.push(url),
  };
}
const run = (argv: string[], rt: CliRuntime) =>
  runOpenCli(argv, rt, { plugins: [cloudCliPlugin()] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pathrule-native-login-"));
  await writeFile(join(root, ".cli-update-check"), new Date().toISOString(), "utf8");
  await mkdir(join(root, "intelligence"), { recursive: true });
  await writeFile(join(root, "intelligence", ".cli-offered"), new Date().toISOString(), "utf8");
  calls = [];
  signedIn = false;
});
afterEach(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("account commands on Pathrule Cloud", () => {
  it("signs in with the device flow, opens the approval page and keeps the session in a 0600 file", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const opened: string[] = [];
    expect(await run(["login", "--no-color"], runtime(stdout, stderr, opened))).toBe(0);
    expect(stderr.toString()).toBe("");
    expect(opened).toEqual([`${BASE}/device?user_code=WXYZ2345`]);
    expect(stdout.toString()).toContain("One-time code: WXYZ2345");
    expect(stdout.toString()).toContain("Signed in as person@example.invalid");
    expect(stdout.toString()).not.toContain(TOKEN);
    expect(calls[0]).toMatchObject({
      url: `${BASE}/api/auth/device/code`,
      method: "POST",
      body: { client_id: "pathrule-cli-test" },
    });
    expect(calls[1]).toMatchObject({
      url: `${BASE}/api/auth/device/token`,
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "device-1",
        client_id: "pathrule-cli-test",
      },
    });
    expect(calls.every((c) => c.url.startsWith(BASE))).toBe(true);
    if (process.platform !== "win32") {
      expect(
        (await stat(nativeSessionFile({ PATHRULE_HOME: root } as NodeJS.ProcessEnv))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("answers whoami from the server's own session, and leaves status to the open CLI", async () => {
    await run(["login", "--no-color"], runtime());
    const stdout = new MemoryWriter();
    expect(await run(["whoami", "--no-color"], runtime(stdout))).toBe(0);
    expect(stdout.toString()).toContain("User: person@example.invalid");
    // `status` is the open CLI's command; the account gives it a section (account-status tests below).
    const plugin = cloudCliPlugin();
    expect(plugin.commands?.map((c) => c.name)).not.toContain("status");
    expect(plugin.commands?.map((c) => c.name)).toContain("whoami");
    expect(typeof plugin.account?.status).toBe("function");
  });

  it("signs out on the server with the bearer, then reports signed out", async () => {
    await run(["login", "--no-color"], runtime());
    const stdout = new MemoryWriter();
    expect(await run(["logout", "--no-color"], runtime(stdout))).toBe(0);
    expect(stdout.toString()).toContain("Signed out.");
    expect(calls.find((c) => c.url === `${BASE}/api/auth/sign-out`)).toMatchObject({
      method: "POST",
      authorization: `Bearer ${TOKEN}`,
    });
    const stderr = new MemoryWriter();
    expect(await run(["whoami", "--no-color"], runtime(new MemoryWriter(), stderr))).toBe(1);
    expect(stderr.toString()).toContain("Not signed in");
  });

  it("treats a session the server no longer accepts as signed out", async () => {
    await run(["login", "--no-color"], runtime());
    signedIn = false;
    const json = new MemoryWriter();
    expect(await run(["whoami", "--json"], runtime(json))).toBe(1);
    expect(JSON.parse(json.toString())).toMatchObject({
      ok: false,
      error: { code: "not_authenticated" },
    });
  });
});

describe("nativeCloudConfig", () => {
  it("names Pathrule Cloud only when both the URL and the client id are given, and refuses unsafe ones", () => {
    expect(nativeCloudConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(nativeCloudConfig({ PATHRULE_NATIVE_CLOUD_URL: BASE } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      nativeCloudConfig({
        PATHRULE_NATIVE_CLOUD_URL: `${BASE}/`,
        PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      baseUrl: BASE,
      clientId: "pathrule-cli-production",
    });
    expect(() =>
      nativeCloudConfig({
        PATHRULE_NATIVE_CLOUD_URL: "http://cloud.example.test",
        PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli",
      } as NodeJS.ProcessEnv),
    ).toThrow(/https/);
    expect(() =>
      nativeCloudConfig({
        PATHRULE_NATIVE_CLOUD_URL: BASE,
        PATHRULE_NATIVE_DEVICE_CLIENT_ID: "Bad Id",
      } as NodeJS.ProcessEnv),
    ).toThrow(/client id/);
  });
});
