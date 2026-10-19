// SPDX-License-Identifier: Apache-2.0
// Workspace identity through the host: core's discovery rule, unchanged, over the RPC.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

import { scratchHome, type ScratchHome } from "./__fixtures__/helpers.js";
import { createHostClient } from "./client.js";
import { startHost, type RunningHost } from "./host.js";
import {
  listLocalWorkspaces,
  parseListParams,
  parseResolveParams,
  resolveWorkspaceIdentity,
} from "./workspace.js";

let home: ScratchHome;
let host: RunningHost | null = null;

function workspace(id: string, root: string, options: { mirror?: boolean } = {}): void {
  mkdirSync(root, { recursive: true });
  const backend = LocalBackend.openForWorkspace(id, home.env);
  try {
    backend.registerWorkspace({ workspaceId: id, name: id, localRootPath: root });
  } finally {
    backend.close();
  }
  if (options.mirror) LocalBackend.markAsMirror(id, home.env);
}

beforeEach(() => {
  home = scratchHome();
});

afterEach(async () => {
  await host?.stop();
  host = null;
  home.remove();
});

describe("workspace identity", () => {
  it("answers which store serves a folder, the longest root first", () => {
    const outer = join(home.dir, "repo");
    const inner = join(outer, "packages", "app");
    workspace("ws-outer", outer);
    workspace("ws-inner", inner);
    mkdirSync(join(inner, "src"), { recursive: true });
    mkdirSync(join(outer, "docs"), { recursive: true });

    expect(resolveWorkspaceIdentity(join(inner, "src"), home.env)).toEqual({
      workspaceId: "ws-inner",
      root: inner,
      relativePath: "/src",
      mirror: false,
    });
    expect(resolveWorkspaceIdentity(join(outer, "docs"), home.env)?.workspaceId).toBe("ws-outer");
    expect(resolveWorkspaceIdentity(outer, home.env)?.relativePath).toBe("");
    expect(resolveWorkspaceIdentity(home.dir, home.env)).toBeNull();
  });

  it("counts a mirror only when asked, and says it is one", () => {
    const root = join(home.dir, "hosted");
    workspace("ws-mirror", root, { mirror: true });
    expect(resolveWorkspaceIdentity(root, home.env)).toBeNull();
    expect(resolveWorkspaceIdentity(root, home.env, { includeMirrors: true })).toMatchObject({
      workspaceId: "ws-mirror",
      mirror: true,
    });
  });

  it("matches core's own answer exactly", () => {
    const root = join(home.dir, "same");
    workspace("ws-same", root);
    const ours = resolveWorkspaceIdentity(root, home.env);
    const core = LocalBackend.discoverWorkspaceForCwd(root, home.env);
    expect(ours).toMatchObject({
      workspaceId: core?.workspaceId,
      root: core?.localRootPath,
      relativePath: core?.relativePath,
    });
  });

  it("is served over the RPC", async () => {
    const root = join(home.dir, "served");
    workspace("ws-served", root);
    host = await startHost({ env: home.env });
    const client = createHostClient(host.record);
    await expect(client.call("workspace.resolve", { cwd: root })).resolves.toMatchObject({
      workspaceId: "ws-served",
    });
    await expect(client.call("workspace.resolve", { cwd: home.dir })).resolves.toBeNull();
  });

  it("lists every local workspace over the RPC, mirrors left out", async () => {
    workspace("ws-b", join(home.dir, "beta"));
    workspace("ws-a", join(home.dir, "alpha"));
    workspace("ws-hosted", join(home.dir, "hosted"), { mirror: true });
    host = await startHost({ env: home.env });
    const client = createHostClient(host.record);
    await expect(client.call("workspace.list", {})).resolves.toEqual([
      // Registered under their id as the name, so they are named after their folders.
      { id: "ws-a", name: "alpha", rootPath: join(home.dir, "alpha") },
      { id: "ws-b", name: "beta", rootPath: join(home.dir, "beta") },
    ]);
    await expect(client.call("workspace.list", { includeMirrors: false })).resolves.toHaveLength(2);
    // Listing opens no store: the host holds none afterwards.
    expect(host.stores.openWorkspaceIds()).toEqual([]);
    expect(listLocalWorkspaces(home.env).map((w) => w.id)).toEqual(["ws-a", "ws-b"]);
  });

  it.each([
    [{ includeMirrors: true }, "never lists mirrors"],
    [{ includeMirrors: "no" }, "never lists mirrors"],
    [[], "takes an object"],
  ])("refuses the list params %j", (params, message) => {
    expect(() => parseListParams(params)).toThrow(message);
  });

  it.each([
    [{}, "an absolute cwd"],
    [{ cwd: "relative" }, "an absolute cwd"],
    [{ cwd: 7 }, "an absolute cwd"],
    [{ cwd: "/abs", includeMirrors: "yes" }, "must be a boolean"],
  ])("refuses the params %j", (params, message) => {
    expect(() => parseResolveParams(params)).toThrow(message);
  });
});
