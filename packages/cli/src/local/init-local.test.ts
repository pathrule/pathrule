// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { initLocalWorkspace } from "./init-local.js";

describe("initLocalWorkspace", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmps.length = 0;
  });

  function freshHome(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), "pathrule-cli-home-"));
    tmps.push(home);
    return { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
  }

  it("creates a local workspace bound to the cwd and makes it discoverable", async () => {
    const env = freshHome();
    const result = await initLocalWorkspace({
      cwd: "/Users/me/projects/acme",
      env,
      genWorkspaceId: () => "ws-fixed",
    });
    expect(result).toEqual({
      workspaceId: "ws-fixed",
      name: "acme", // defaults to the folder name
      localRootPath: "/Users/me/projects/acme",
      action: "created",
      instructions: null, // the folder has no instruction files
    });
    // The store is now discoverable for the cwd (and subpaths).
    expect(
      LocalBackend.discoverWorkspaceForCwd("/Users/me/projects/acme/src", env)?.workspaceId,
    ).toBe("ws-fixed");
  });

  it("is idempotent — a folder already inside a local workspace reuses it", async () => {
    const env = freshHome();
    const first = await initLocalWorkspace({ cwd: "/repo", env, genWorkspaceId: () => "ws-1" });
    expect(first.action).toBe("created");

    // A subfolder of an existing local workspace must NOT create a second store.
    const second = await initLocalWorkspace({
      cwd: "/repo/packages/api",
      env,
      genWorkspaceId: () => "ws-2-should-not-be-used",
    });
    expect(second.action).toBe("exists");
    expect(second.workspaceId).toBe("ws-1");
    expect(second.localRootPath).toBe("/repo");
  });

  function repoWithClaudeMd(): string {
    const root = mkdtempSync(join(tmpdir(), "pathrule-cli-ws-"));
    tmps.push(root);
    writeFileSync(join(root, "CLAUDE.md"), "## Acme release train\n\nShip on Tuesdays.\n");
    return root;
  }

  it("imports the instruction files before the first hook-index warm-up", async () => {
    const env = freshHome();
    const cwd = repoWithClaudeMd();

    const result = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-import" });

    expect(result.instructions).toEqual({
      imported: 1,
      failed: 0,
      inPathrule: ["CLAUDE.md"],
      notImported: [],
    });
    // The first prompt already carries what was imported, with no sync in between.
    const index = readFileSync(join(env.PATHRULE_HOME!, "cache", "ws-import", "hook-index.json"));
    expect(index.toString("utf8")).toContain("Acme release train");
  });

  it("imports into an existing workspace only while it is empty, unless asked", async () => {
    const env = freshHome();
    const cwd = repoWithClaudeMd();
    // A workspace made before the import existed: bound, empty, no instruction memories.
    const backend = LocalBackend.openForWorkspace("ws-old", env);
    backend.registerWorkspace({ workspaceId: "ws-old", name: "old", localRootPath: cwd });
    backend.close();

    const first = await initLocalWorkspace({ cwd, env });
    expect(first.action).toBe("exists");
    expect(first.instructions?.imported).toBe(1);

    // Now it has content. A new instruction file waits for an explicit request.
    mkdirSync(join(cwd, "packages/api"), { recursive: true });
    writeFileSync(join(cwd, "packages/api/AGENTS.md"), "## Errors\n\nWrap them.\n");
    const second = await initLocalWorkspace({ cwd, env });
    expect(second.instructions).toEqual(
      expect.objectContaining({ imported: 0, notImported: ["packages/api/AGENTS.md"] }),
    );

    const asked = await initLocalWorkspace({ cwd, env, instructionImport: "missing" });
    expect(asked.instructions).toEqual(expect.objectContaining({ imported: 1, notImported: [] }));
  });

  it("honors an explicit workspace name", async () => {
    const env = freshHome();
    const result = await initLocalWorkspace({
      cwd: "/tmp/x",
      name: "My Site",
      env,
      genWorkspaceId: () => "w",
    });
    expect(result.name).toBe("My Site");
  });
});
