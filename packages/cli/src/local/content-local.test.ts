// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { initLocalWorkspace } from "./init-local.js";
import { listLocalContent, searchLocalContent, readLocalContent } from "./content-local.js";

describe("local content browsing", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  async function setup() {
    const home = mkdtempSync(join(tmpdir(), "pathrule-content-home-"));
    tmps.push(home);
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    const cwd = "/Users/me/proj";
    const { workspaceId } = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-1" });
    return { env, cwd, workspaceId };
  }

  it("lists, searches, reads, and path-filters local content with no login", async () => {
    const { env, cwd, workspaceId } = await setup();

    // Seed via the same local store the CLI will read.
    const seed = LocalBackend.openForWorkspace(workspaceId, env);
    const node = await seed.ensureNodeForPath(workspaceId, "/api");
    await seed.writeMemory({
      workspaceId,
      nodeId: node.id,
      title: "Auth flow",
      content: "JWT login refresh",
    });
    await seed.writeRule({
      workspaceId,
      nodeId: node.id,
      name: "No console.log",
      content: "do not log",
      scopeType: "project",
    });
    await seed.writeSkill({
      workspaceId,
      nodeId: node.id,
      name: "Deploy",
      content: "deploy steps",
    });
    seed.close();

    // list — local items carry no cloud/desktop deep-links.
    const mems = await listLocalContent("memory", cwd, env);
    expect(mems).toHaveLength(1);
    expect(mems[0]).toMatchObject({
      kind: "memory",
      title: "Auth flow",
      path: "/api",
      url: "",
      open_targets: [],
    });

    // search across kinds by keyword.
    const found = await searchLocalContent("auth", cwd, env);
    expect(found.some((i) => i.title === "Auth flow")).toBe(true);

    // read by title returns the full body.
    const read = await readLocalContent("memory", "Auth flow", cwd, env);
    expect(read.content).toContain("JWT");

    // path filter scopes to the subtree.
    const rules = await listLocalContent("rule", cwd, env, { path: "/api" });
    expect(rules.map((r) => r.title)).toContain("No console.log");
    expect(await listLocalContent("rule", cwd, env, { path: "/web" })).toHaveLength(0);
  });

  it("throws a clear 'init --local' error when no local workspace covers the cwd", async () => {
    const { env } = await setup();
    await expect(listLocalContent("memory", "/somewhere/unrelated", env)).rejects.toThrow(
      /init --local/,
    );
  });
});
