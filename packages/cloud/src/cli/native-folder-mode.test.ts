// SPDX-License-Identifier: Apache-2.0
// The account's commands follow the edition that serves the folder (core's resolveFolderMode): the
// account's part of `pathrule status`, the doctor's checks, `attach`, `detach` and the commands that
// need the folder's Cloud workspace. A Pathrule Local folder is never served from Cloud, a Cloud
// folder is never served from Local, and a detach leaves nothing of the Cloud workspace usable here.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initLocalWorkspace } from "@pathrule/cli/local/init-local.js";
import type { CliCommandContext, CliRuntime } from "@pathrule/cli/plugin.js";
import { recordFolderChoice, resolveFolderMode } from "@pathrule/core/workspace/folder-mode.js";
import { KNOWLEDGE_BANNER } from "@pathrule/integrations/client-renderers/knowledge-files.js";

import { writeNativeSession } from "../native/credentials.js";
import { attachNativeWorkspace, readNativeWorkspaces } from "../native/workspaces.js";
import { jsonNative, renderNative } from "./commands/native-commands.js";
import { nativeAccountStatus, renderNativeLogin } from "./commands/native-account.js";
import { cloudCliPlugin } from "./plugin.js";

const BASE = "https://cloud.example.test";
const TOKEN = "t".repeat(32);

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

let home: string;
let shop: string;
let env: NodeJS.ProcessEnv;
let calls: { path: string; method: string; owner: string | null }[];
/** How the workspace's capabilities route answers: a status, or a network failure. */
let capabilities: number | "offline" | "hang";

const fakeCloud = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  calls.push({
    path: url.pathname,
    method: init?.method ?? "GET",
    owner: headers.get("x-native-owner"),
  });
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  if (url.pathname === "/api/auth/device/code")
    return json({ device_code: "d1", user_code: "WXYZ2345", verification_uri: `${BASE}/device` });
  if (url.pathname === "/api/auth/device/token")
    return json({ access_token: TOKEN, token_type: "Bearer" });
  if (headers.get("authorization") !== `Bearer ${TOKEN}`) return json({ error: "no session" }, 401);
  switch (url.pathname) {
    case "/api/auth/get-session":
      return json({
        session: { expiresAt: "2099-01-01T00:00:00.000Z" },
        user: { id: "user-1", email: "person@example.invalid" },
      });
    case "/v1/me/identity":
      return json({ userId: "user-1" });
    case "/v1/organizations":
      return json({
        items: [{ id: "org-1", name: "Org", role: "owner", revision: 1, plan: null }],
      });
    case "/v1/organizations/org-1/workspaces":
      return json({ items: [{ id: "ws-cloud", organization_id: "org-1", name: "Shop" }] });
    case "/v1/workspaces/ws-cloud/foundation/project/capabilities":
      if (capabilities === "offline") throw new TypeError("fetch failed");
      if (capabilities === "hang")
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        );
      return json(capabilities === 200 ? {} : { error: "Workspace not authorized" }, capabilities);
    default:
      return json({ error: "not found" }, 404);
  }
}) as typeof fetch;

async function signIn() {
  await writeNativeSession(
    {
      base_url: BASE,
      user_id: "user-1",
      token: TOKEN,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    { env },
  );
}

const attachShop = () =>
  attachNativeWorkspace(
    "user-1",
    { workspace_id: "ws-cloud", organization_id: "org-1", name: "Shop", root: shop },
    env,
  );

const folder = (cwd = shop) => resolveFolderMode(cwd, env, { cloudAvailable: true });

function cli(cwd = shop) {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const runtime = { cwd, env, stdout, stderr, fetch: fakeCloud } as unknown as CliRuntime;
  const ctx = (command: string, args: string[] = [], json = false): CliCommandContext =>
    ({
      command,
      args,
      flags: {},
      runtime,
      mode: { json, color: false, interactive: false, noOpen: true },
    }) as unknown as CliCommandContext;
  return { stdout, stderr, ctx };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-folder-mode-")));
  shop = join(home, "shop");
  mkdirSync(shop);
  // A build that names a Cloud, and an install that never chose: a folder is a Cloud folder.
  env = {
    PATHRULE_HOME: home,
    PATHRULE_LOCAL_PRINCIPAL: "tester",
    PATHRULE_DAEMON_AUTOSTART: "0",
    PATHRULE_NATIVE_CLOUD_URL: BASE,
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  };
  calls = [];
  capabilities = 200;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("a sign-in", () => {
  const index = (workspaceId: string, root: string) => {
    mkdirSync(join(home, "cache", workspaceId), { recursive: true });
    writeFileSync(
      join(home, "cache", workspaceId, "hook-index.json"),
      JSON.stringify({ schema_version: 2, workspace_id: workspaceId, workspace_root: root }),
    );
  };
  const login = async () => {
    const stdout = new MemoryWriter();
    const runtime = {
      cwd: shop,
      env,
      stdout,
      stderr: new MemoryWriter(),
      fetch: fakeCloud,
      sleep: async () => {},
    } as unknown as CliRuntime;
    const mode = { json: false, color: false, interactive: false, noOpen: true };
    expect(
      await renderNativeLogin(runtime, mode as never, {
        baseUrl: BASE,
        clientId: "pathrule-cli-test",
      }),
    ).toBe(0);
    return stdout.toString();
  };

  it("restores a Cloud folder's binding from this machine's index, on a line of its own", async () => {
    index("ws-cloud", shop);
    const out = await login();
    expect(out).toContain("Signed in as person@example.invalid");
    expect(out).toContain(
      `Attached ${shop} to Pathrule Cloud workspace "Shop" (this machine's index for the folder names it). Undo: pathrule detach`,
    );
    expect(await readNativeWorkspaces("user-1", env)).toMatchObject([{ workspace_id: "ws-cloud" }]);
  });

  it("binds nothing in a Pathrule Local workspace's folder, by its index or its name", async () => {
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    index("ws-cloud", shop);
    const out = await login();
    expect(out).toContain("Signed in as person@example.invalid");
    expect(out).not.toContain("Attached");
    expect(await readNativeWorkspaces("user-1", env)).toEqual([]);
    expect(calls.map((c) => c.path)).not.toContain("/v1/organizations");
  });
});

describe("the account's part of pathrule status", () => {
  const status = (timeoutMs?: number) =>
    nativeAccountStatus({ env, cwd: shop, folder: folder(), fetch: fakeCloud, timeoutMs });

  it("is no problem for a Pathrule Local folder signed out, and asks the Cloud nothing", async () => {
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    expect(folder().mode).toBe("local");
    expect(await status()).toEqual({
      lines: ["Pathrule Cloud: signed out"],
      data: { signed_in: false, user: null, workspace: null, reachable: null },
      problem: null,
    });
    expect(calls).toEqual([]);
  });

  it("is a problem for a Pathrule Cloud folder signed out", async () => {
    expect((await status()).problem).toEqual({
      code: "not_signed_in",
      message: "This folder uses Pathrule Cloud, and Pathrule CLI is not signed in.",
      next: "pathrule login",
    });
  });

  it("names the person, the session's expiry, the workspace and its organization, and that the Cloud answers", async () => {
    await signIn();
    await attachShop();
    const section = await status();
    expect(section.problem).toBeNull();
    expect(section.lines).toEqual([
      "Pathrule Cloud: signed in as person@example.invalid (session expires 2099-01-01T00:00:00.000Z)",
      `Pathrule Cloud workspace: "Shop" (ws-cloud), organization org-1, attached at ${shop}`,
      'Pathrule Cloud answers for "Shop".',
    ]);
    expect(section.data).toMatchObject({
      signed_in: true,
      user: { id: "user-1", email: "person@example.invalid" },
      workspace: { id: "ws-cloud", name: "Shop", organization_id: "org-1", root: shop },
      reachable: true,
    });
    expect(calls.at(-1)).toEqual({
      path: "/v1/workspaces/ws-cloud/foundation/project/capabilities",
      method: "POST",
      owner: "user-1",
    });
  });

  it("is a problem for a Cloud folder not attached, without access, or unreachable", async () => {
    await signIn();
    expect((await status()).problem).toMatchObject({
      code: "not_attached",
      next: "pathrule setup --cloud",
    });
    await attachShop();
    capabilities = 403;
    expect((await status()).problem).toMatchObject({ code: "no_access" });
    capabilities = "offline";
    expect((await status()).problem).toMatchObject({ code: "cloud_unreachable" });
    capabilities = "hang";
    const slow = await status(50);
    expect(slow.problem).toEqual({
      code: "cloud_unreachable",
      message: "Pathrule Cloud did not answer: no answer within 0.05s.",
    });
    expect(slow.data).toMatchObject({ reachable: false });
  });
});

describe("the doctor's checks follow the folder's edition", () => {
  const account = cloudCliPlugin().account!;
  const doctor = async (cwd = shop) => {
    const checks = await account.doctorChecks(env, cwd);
    return { checks, next: account.doctorNextStep(checks) };
  };

  it("warns nothing for a Pathrule Local folder, signed out and with a dormant Cloud attachment", async () => {
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    await attachShop();
    recordFolderChoice(env, shop, "local", "setup");
    const { checks, next } = await doctor();
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["auth", "pass"],
      ["cwd_attach", "pass"],
      ["deliveries_report", "pass"],
    ]);
    expect(checks[1]!.detail).toContain('its Pathrule Cloud attachment ("Shop") is not used');
    expect(next).toBeNull();
  });

  it("fails a Pathrule Cloud folder signed out, then warns it unattached", async () => {
    let { checks, next } = await doctor();
    expect(checks.find((c) => c.name === "auth")).toMatchObject({ status: "fail" });
    expect(next).toBe("pathrule login");
    await signIn();
    ({ checks, next } = await doctor());
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["auth", "pass"],
      ["cwd_attach", "warn"],
      ["deliveries_report", "pass"],
    ]);
    expect(next).toBe("pathrule setup --cloud");
    await attachShop();
    ({ checks, next } = await doctor(join(shop)));
    expect(checks.find((c) => c.name === "cwd_attach")).toMatchObject({ status: "pass" });
    expect(next).toBeNull();
  });

  it("fails a folder in conflict until the person chooses", async () => {
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    await attachShop();
    const { checks, next } = await doctor();
    expect(checks.find((c) => c.name === "cwd_attach")).toMatchObject({ status: "fail" });
    expect(next).toBe("pathrule setup --cloud or pathrule setup --local");
  });
});

describe("the folder's Cloud workspace", () => {
  it("never serves a Pathrule Local folder its Cloud workspace", async () => {
    await signIn();
    await attachShop();
    recordFolderChoice(env, shop, "local", "setup");
    const { ctx } = cli();
    const result = await jsonNative(ctx("workspace", ["current"], true));
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({ ok: false, error: { code: "folder_is_local" } });
    const preflight = await jsonNative(ctx("preflight", ["write"], true));
    expect(preflight.envelope).toMatchObject({ ok: false, error: { code: "folder_is_local" } });
  });

  it("restores a Cloud folder's binding from this machine's index, and says so", async () => {
    await signIn();
    mkdirSync(join(home, "cache", "ws-cloud"), { recursive: true });
    writeFileSync(
      join(home, "cache", "ws-cloud", "hook-index.json"),
      JSON.stringify({ schema_version: 2, workspace_id: "ws-cloud", workspace_root: shop }),
    );
    const { ctx, stderr } = cli();
    expect(await renderNative(ctx("workspace", ["current"]))).toBe(0);
    expect(stderr.toString()).toContain(
      `Attached ${shop} to Pathrule Cloud workspace "Shop" (this machine's index for the folder names it). Undo: pathrule detach`,
    );
    expect(await readNativeWorkspaces("user-1", env)).toMatchObject([{ workspace_id: "ws-cloud" }]);
  });
});

describe("attach and detach", () => {
  it("refuses to attach a Pathrule Local workspace's folder, which setup --cloud moves", async () => {
    await signIn();
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    const { ctx } = cli();
    const result = await jsonNative(ctx("attach", ["Shop"], true));
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: "folder_is_local" },
      next_steps: [{ command: "pathrule setup --cloud" }],
    });
    expect(await readNativeWorkspaces("user-1", env)).toEqual([]);
  });

  it("detaches, removes this machine's cache and the rendered knowledge, and says Local renders again", async () => {
    await signIn();
    // A folder in conflict: its Local workspace and its Cloud attachment, no choice between them.
    await initLocalWorkspace({ cwd: shop, env, genWorkspaceId: () => "ws-local" });
    await attachShop();
    expect(folder().mode).toBeNull();
    const put = (path: string, body: string) => {
      mkdirSync(dirname(join(shop, path)), { recursive: true });
      writeFileSync(join(shop, path), body);
    };
    put(".claude/rules/pathrule/workspace.md", `${KNOWLEDGE_BANNER}\n# Instructions\n`);
    put(".claude/settings.json", '{"hooks":{}}\n');
    mkdirSync(join(home, "cache", "ws-cloud"), { recursive: true });
    writeFileSync(join(home, "cache", "ws-cloud", "hook-index.json"), "{}");
    const { ctx, stdout } = cli();
    expect(await renderNative(ctx("detach"))).toBe(0);
    expect(stdout.toString().split("\n")).toEqual([
      `[ok] Detached ${shop} from Pathrule Cloud workspace "Shop". Nothing was deleted on Pathrule Cloud.`,
      'Removed 1 cached item(s) of "Shop" from this machine.',
      `Removed 1 Pathrule knowledge file(s) from ${shop}.`,
      "This folder uses its Pathrule Local workspace again: `pathrule sync` renders its Local knowledge.",
      "",
    ]);
    expect(existsSync(join(shop, ".claude/rules/pathrule"))).toBe(false);
    expect(existsSync(join(shop, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(home, "cache", "ws-cloud", "hook-index.json"))).toBe(false);
    expect(folder()).toMatchObject({ mode: "local", local: { workspaceId: "ws-local" } });
  });

  it("reports counts in --json, and a Cloud folder left without a workspace", async () => {
    await signIn();
    await attachShop();
    const { ctx } = cli();
    const result = await jsonNative(ctx("detach", [], true));
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        workspace_id: "ws-cloud",
        removed: { cache_items: 0, cache_kept: null, knowledge_files: 0, stripped_files: 0 },
        folder_mode: "cloud",
      },
    });
    const again = await jsonNative(ctx("detach", [], true));
    expect(again.envelope).toMatchObject({ ok: false, error: { code: "not_attached" } });
  });
});
