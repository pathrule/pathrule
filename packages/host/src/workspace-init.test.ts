// SPDX-License-Identifier: Apache-2.0
// Creating a local workspace through the host: the store, the root, and the first hook index, with the
// person's lines only when an engine answers.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import type { HookIndex } from "@pathrule/protocol/hook-index.js";

import { scratchHome, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost } from "./client.js";
import { startHost } from "./host.js";
import { WorkspaceStores } from "./stores.js";
import { initLocalWorkspace, parseInitParams } from "./workspace-init.js";

let home: ScratchHome;
let stores: WorkspaceStores;
let lines: string[];

const deps = () => ({ env: home.env, stores, log: (line: string) => lines.push(line) });
const indexOf = (workspaceId: string): HookIndex =>
  JSON.parse(
    readFileSync(join(home.env.PATHRULE_HOME!, "cache", workspaceId, "hook-index.json"), "utf8"),
  );

beforeEach(() => {
  home = scratchHome();
  stores = new WorkspaceStores(home.env);
  lines = [];
});

afterEach(() => {
  stores.closeAll();
  home.remove();
});

describe("workspace.init", () => {
  it("creates the store, binds the folder and writes a first hook index", async () => {
    const folder = join(home.dir, "repo");
    mkdirSync(folder);
    const created = await initLocalWorkspace(
      { folder: `${folder}/` },
      { ...deps(), newWorkspaceId: () => "ws-new" },
    );
    expect(created).toEqual({
      workspaceId: "ws-new",
      name: "repo",
      localRootPath: folder,
      action: "created",
    });
    expect(existsSync(join(home.env.PATHRULE_HOME!, "ws-new", "pathrule.db"))).toBe(true);
    expect(LocalBackend.discoverWorkspaceForCwd(folder, home.env)?.workspaceId).toBe("ws-new");
    const index = indexOf("ws-new");
    expect(index.workspace_id).toBe("ws-new");
    expect(index.workspace_root).toBe(folder);
    // No engine: the person's lines are not on the index.
    expect(index.user_preferences).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("reuses the workspace that already covers a folder, from its root or below it", async () => {
    const folder = join(home.dir, "repo");
    mkdirSync(join(folder, "src"), { recursive: true });
    await initLocalWorkspace({ folder, name: "Mine" }, { ...deps(), newWorkspaceId: () => "ws-1" });
    await expect(initLocalWorkspace({ folder }, deps())).resolves.toEqual({
      workspaceId: "ws-1",
      name: "repo",
      localRootPath: folder,
      action: "exists",
    });
    await expect(
      initLocalWorkspace({ folder: join(folder, "src"), name: "Named" }, deps()),
    ).resolves.toMatchObject({
      workspaceId: "ws-1",
      name: "Named",
      action: "exists",
    });
  });

  it("writes the first index without the person's lines, and logs nothing", async () => {
    const folder = join(home.dir, "plain");
    mkdirSync(folder);
    const created = await initLocalWorkspace(
      { folder },
      { ...deps(), newWorkspaceId: () => "ws-plain" },
    );
    expect(created.action).toBe("created");
    expect(indexOf("ws-plain").user_preferences).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("is served over the RPC", async () => {
    const host = await startHost({ env: home.env });
    try {
      const client = (await connectHost({ env: home.env }))!;
      const folder = join(home.dir, "served");
      mkdirSync(folder);
      const created = await client.call("workspace.init", { folder });
      expect(created).toMatchObject({ name: "served", localRootPath: folder, action: "created" });
      await expect(client.call("workspace.resolve", { cwd: folder })).resolves.toMatchObject({
        workspaceId: created.workspaceId,
      });
      expect(host.stores.openWorkspaceIds()).toEqual([created.workspaceId]);
    } finally {
      await host.stop();
    }
  });

  it.each([
    [{}, "an absolute folder"],
    [{ folder: "relative" }, "an absolute folder"],
    [{ folder: "/abs", name: 3 }, "name must be a string"],
  ])("refuses the params %j", (params, message) => {
    expect(() => parseInitParams(params)).toThrow(message);
  });
});
