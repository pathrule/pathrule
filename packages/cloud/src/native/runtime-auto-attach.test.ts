// SPDX-License-Identifier: Apache-2.0
// Until 2026-10-19 the MCP server's runtime attached the folder it served once per signed-in run,
// by the folder's hook index or its name, with nobody told: a Local workspace's folder could become a
// Cloud folder behind the person's back. The runtime binds nothing now; the CLI restores a binding,
// on a line of its own (auto-attach.ts).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeNativeSession } from "./credentials.js";
import { nativeCloudRuntime } from "./runtime.js";
import { attachNativeWorkspace, readNativeWorkspaces } from "./workspaces.js";

const BASE = "https://cloud.test";
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function fakeCloud(workspaces: Array<{ id: string; name: string }>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    calls.push(url.pathname);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/me/identity") return json({ userId: "person-1" });
    if (url.pathname === "/v1/organizations") return json({ items: [{ id: "org-1" }] });
    if (url.pathname === "/v1/organizations/org-1/workspaces")
      return json({ items: workspaces.map((w) => ({ ...w, organization_id: "org-1" })) });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pr-runtime-auto-attach-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  env = {
    PATHRULE_HOME: home,
    PATHRULE_NATIVE_CLOUD_URL: BASE,
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  };
  const dir = join(home, "cache", "ws-cloud");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hook-index.json"),
    JSON.stringify({ schema_version: 2, workspace_id: "ws-cloud", workspace_root: repo }),
  );
  await writeNativeSession(
    {
      base_url: BASE,
      user_id: "person-1",
      token: "t".repeat(32),
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    { env },
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the native runtime binds no folder", () => {
  it("serves the attachments on file and asks the Cloud for no workspace list", async () => {
    const cloud = fakeCloud([{ id: "ws-cloud", name: "Repo" }]);
    const runtime = nativeCloudRuntime({ env, fetch: cloud.fetch });
    expect(runtime).not.toBeNull();
    // The hook index names a workspace the person can read: still nothing is attached.
    expect((await runtime!.person())?.workspaces).toEqual([]);
    expect((await runtime!.person())?.workspaces).toEqual([]);
    expect(cloud.calls).not.toContain("/v1/organizations");
    expect(await readNativeWorkspaces("person-1", env)).toEqual([]);
  });

  it("lists a folder the person attached", async () => {
    await attachNativeWorkspace(
      "person-1",
      { workspace_id: "ws-cloud", organization_id: "org-1", name: "Repo", root: repo },
      env,
    );
    const cloud = fakeCloud([{ id: "ws-cloud", name: "Repo" }]);
    const runtime = nativeCloudRuntime({ env, fetch: cloud.fetch });
    expect((await runtime!.person())?.workspaces).toMatchObject([
      { workspace_id: "ws-cloud", root: realpathSync(repo) },
    ]);
  });
});
