// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initLocalWorkspace } from "@pathrule/cli/local/init-local.js";
import { PATHRULE_REGION } from "@pathrule/core/paths/region.js";
import {
  readCloudFolderBindings,
  resolveFolderMode,
} from "@pathrule/core/workspace/folder-mode.js";
import { KNOWLEDGE_BANNER } from "@pathrule/integrations/client-renderers/knowledge-files.js";

import {
  attachNativeWorkspace,
  clearDetachedFolder,
  detachNativeWorkspace,
  nativeMappings,
  nativeWorkspaceFor,
  nativeWorkspacesFile,
  readNativeWorkspaces,
  type NativeWorkspaceEntry,
} from "./workspaces.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-native-workspaces-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const entry = (workspace_id: string, root: string) => ({
  workspace_id,
  organization_id: "org-1",
  name: `Workspace ${workspace_id}`,
  root,
});

describe("the folders a person attached to Pathrule Cloud", () => {
  it("are none until a folder is attached, and stay private to the person", async () => {
    expect(await readNativeWorkspaces("person-a", env)).toEqual([]);
    await attachNativeWorkspace("person-a", entry("ws-1", "/work/app"), env);
    expect(statSync(nativeWorkspacesFile("person-a", env)).mode & 0o777).toBe(0o600);
    expect(await readNativeWorkspaces("person-b", env)).toEqual([]);
    expect(await readNativeWorkspaces("person-a", env)).toMatchObject([
      { workspace_id: "ws-1", root: "/work/app" },
    ]);
  });

  it("give a folder one workspace and a workspace one folder", async () => {
    await attachNativeWorkspace("person-a", entry("ws-1", "/work/app"), env);
    await attachNativeWorkspace("person-a", entry("ws-2", "/work/site"), env);
    await attachNativeWorkspace("person-a", entry("ws-3", "/work/app"), env);
    await attachNativeWorkspace("person-a", entry("ws-2", "/work/site-2"), env);
    expect(
      (await readNativeWorkspaces("person-a", env)).map((e) => [e.workspace_id, e.root]),
    ).toEqual([
      ["ws-3", "/work/app"],
      ["ws-2", "/work/site-2"],
    ]);
  });

  it("serve a folder from the longest attached root containing it", async () => {
    await attachNativeWorkspace("person-a", entry("ws-1", "/work"), env);
    await attachNativeWorkspace("person-a", entry("ws-2", "/work/app"), env);
    const entries = await readNativeWorkspaces("person-a", env);
    expect(nativeWorkspaceFor(entries, "/work/app/src")?.workspace_id).toBe("ws-2");
    expect(nativeWorkspaceFor(entries, "/work/docs")?.workspace_id).toBe("ws-1");
    expect(nativeWorkspaceFor(entries, "/work-other")).toBeNull();
  });

  it("detach the folder that serves the current one, and nothing when none does", async () => {
    await attachNativeWorkspace("person-a", entry("ws-1", "/work/app"), env);
    expect(await detachNativeWorkspace("person-a", "/elsewhere", env)).toBeNull();
    expect((await detachNativeWorkspace("person-a", "/work/app/src", env))?.workspace_id).toBe(
      "ws-1",
    );
    expect(await readNativeWorkspaces("person-a", env)).toEqual([]);
  });

  it("name the Cloud workspace on both sides of the composition's mapping", async () => {
    await attachNativeWorkspace("person-a", entry("ws-1", "/work/app"), env);
    expect(nativeMappings(await readNativeWorkspaces("person-a", env))).toEqual([
      {
        localWorkspaceId: "ws-1",
        cloudWorkspaceId: "ws-1",
        cloudOrganizationId: "org-1",
        localRootPath: "/work/app",
      },
    ]);
  });

  it("refuse an id that is not a Pathrule Cloud id", async () => {
    await expect(
      attachNativeWorkspace("person-a", entry("../escape", "/work/app"), env),
    ).rejects.toThrow("not a Pathrule Cloud workspace id");
  });
});

describe("core's reader of attachments", () => {
  it("reads an attachment back as the same binding, its root canonical, and serves the same folder", async () => {
    const app = join(home, "app");
    mkdirSync(join(app, "src"), { recursive: true });
    const link = join(home, "link");
    symlinkSync(app, link);
    await attachNativeWorkspace(
      "person-a",
      { workspace_id: "ws-1", organization_id: "org-1", name: "Shop", root: `${link}/` },
      env,
    );
    const canonical = realpathSync(app);
    expect(readCloudFolderBindings(env)).toEqual([
      { workspaceId: "ws-1", organizationId: "org-1", name: "Shop", root: canonical },
    ]);
    const entries = await readNativeWorkspaces("person-a", env);
    expect(entries).toMatchObject([
      { workspace_id: "ws-1", organization_id: "org-1", name: "Shop", root: canonical },
    ]);
    // Reached through the symlink, both name the same workspace for the folder.
    expect(nativeWorkspaceFor(entries, join(link, "src"))?.workspace_id).toBe("ws-1");
    expect(resolveFolderMode(join(link, "src"), env, { cloudAvailable: true })).toMatchObject({
      mode: "cloud",
      cloud: { workspaceId: "ws-1", root: canonical },
    });
  });
});

describe("clearing a detached folder", () => {
  let repo: string;
  const entry = (): NativeWorkspaceEntry => ({
    workspace_id: "ws-cloud",
    organization_id: "org-1",
    name: "Shop",
    root: repo,
    attached_at: "2026-10-19T00:00:00.000Z",
  });
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  const knowledge = (title: string) => `${KNOWLEDGE_BANNER}\n# ${title}\n\nUse the cart service.\n`;
  const cache = (...parts: string[]) => join(home, "cache", "ws-cloud", ...parts);

  beforeEach(() => {
    home = realpathSync(home);
    env = { ...env, PATHRULE_HOME: home, PATHRULE_LOCAL_PRINCIPAL: "tester" };
    repo = join(home, "repo");
    // What a Cloud sync rendered: signature mode's rules folder, and banner files on the ledger.
    put(".claude/rules/pathrule/workspace.md", knowledge("Project instructions (Pathrule)"));
    put(
      ".claude/rules/pathrule/apps-api.md",
      `---\npaths:\n  - "apps/api/**"\n---\n${knowledge("api")}`,
    );
    put(
      ".claude/rules/pathrule/manifest.json",
      '{"_":"# >>> Pathrule managed: binding manifest"}\n',
    );
    put(
      ".claude/rules/pathrule/.gitignore",
      "# Pathrule managed: compiled instructions, regenerated on sync.\n*\n",
    );
    put(".claude/rules/pathrule-knowledge.md", knowledge("Workspace knowledge (Pathrule)"));
    put("apps/api/CLAUDE.md", knowledge("Project knowledge for /apps/api"));
    put(
      "docs/AGENTS.md",
      `My own notes.\n\n${PATHRULE_REGION.begin}\n${knowledge("docs")}${PATHRULE_REGION.end}\n`,
    );
    // What stays: the hook entries and the person's own files. Pathrule's protocol copy goes: the folder
    // is served by nothing, so an agent must not read instructions to use it.
    put(".claude/settings.json", '{"hooks":{"UserPromptSubmit":[{"command":"pathrule-hook"}]}}\n');
    put(".claude/rules/pathrule-protocol.md", "<!-- Pathrule managed (protocol) -->\n# Pathrule\n");
    put("notes/CLAUDE.md", "# My notes\n\nNot Pathrule's.\n");
    const ledger = [
      ".claude/rules/pathrule-knowledge.md",
      ".claude/rules/pathrule-protocol.md",
      ".claude/rules/pathrule/workspace.md",
      ".claude/settings.json",
      "apps/api/CLAUDE.md",
      "docs/AGENTS.md",
    ].map((path) => ({
      path,
      owner: "cli",
      owner_version: "1.0.0",
      updated_at: "2026-10-18T00:00:00.000Z",
    }));
    put(".pathrule/managed-files.json", JSON.stringify({ schema_version: 1, files: ledger }));
    // This machine's cache of the workspace, and a store named by its id.
    mkdirSync(cache("deliveries"), { recursive: true });
    writeFileSync(cache("deliveries", "s1.jsonl"), "{}\n");
    writeFileSync(cache("hook-index.json"), "{}");
    writeFileSync(cache("session-s1.json"), "{}");
    mkdirSync(join(home, "ws-cloud"));
    writeFileSync(join(home, "ws-cloud", "pathrule.db"), "");
  });

  it("removes the cache and every instruction Pathrule wrote, and keeps the person's files and the hook entries", async () => {
    const cleanup = await clearDetachedFolder(entry(), env, { knowledge: true });
    expect(cleanup).toEqual({
      cache: { removed: 3, kept: null },
      knowledge: { removed: 7, stripped: 1, unclear: [], errors: [] },
    });
    expect(existsSync(join(repo, ".claude/rules/pathrule"))).toBe(false);
    for (const gone of [".claude/rules/pathrule-knowledge.md", ".claude/rules/pathrule-protocol.md", "apps/api/CLAUDE.md"])
      expect(existsSync(join(repo, gone))).toBe(false);
    expect(readFileSync(join(repo, "docs/AGENTS.md"), "utf8")).toBe("My own notes.\n");
    for (const kept of [".claude/settings.json", "notes/CLAUDE.md"]) expect(existsSync(join(repo, kept))).toBe(true);
    expect(readFileSync(join(repo, "notes/CLAUDE.md"), "utf8")).toBe("# My notes\n\nNot Pathrule's.\n");
    const ledger = JSON.parse(readFileSync(join(repo, ".pathrule/managed-files.json"), "utf8")) as {
      files: { path: string }[];
    };
    expect(ledger.files.map((f) => f.path)).toEqual([".claude/settings.json"]);
    // Receipts not reported yet stay; the hook index, the session caches and the store go.
    expect(existsSync(cache("deliveries", "s1.jsonl"))).toBe(true);
    expect(existsSync(cache("hook-index.json"))).toBe(false);
    expect(existsSync(cache("session-s1.json"))).toBe(false);
    expect(existsSync(join(home, "ws-cloud"))).toBe(false);
  });

  it("takes Pathrule's region out of every protocol file an agent reads, and leaves one it cannot bound", async () => {
    const sections =
      "<!-- pathrule:promoted-rules:begin -->\n## Workspace Rules (Pathrule)\n\n1. **Cart** — CART_KEY_7731\n<!-- pathrule:promoted-rules:end -->\n\n" +
      "## Workspace knowledge (Pathrule)\n\nRefunds go through ledger-v9.\n\n## Team (Pathrule)\n\nAda owns /payments.";
    const protocol = "<!-- Pathrule managed (protocol) -->\n# Pathrule\n\nPathrule is active here.";
    put("AGENTS.md", `# Mine\n\nRun make lint.\n\n${PATHRULE_REGION.begin}\n${protocol}\n\n${sections}\n${PATHRULE_REGION.end}\n`);
    // An older render, the end anchor lost: where Pathrule's text stops cannot be told.
    const lost = `My rule.\n\n${PATHRULE_REGION.begin}\n${protocol}\n\n${sections}\n`;
    put(".windsurfrules", lost);
    // Pathrule's own protocol file of a client, before anchors.
    put(".cursor/rules/pathrule-protocol.mdc", `${protocol}\n\n${sections}\n`);
    // The person's file, with the same heading and no marker: never touched.
    const mine = "# Notes\n\n## Workspace knowledge (Pathrule)\n\nmy copy\n";
    put(".cursorrules", mine);
    const cleanup = await clearDetachedFolder(entry(), env, { knowledge: true });
    expect(cleanup.knowledge.errors).toEqual([]);
    expect(cleanup.knowledge.stripped).toBe(2); // AGENTS.md and docs/AGENTS.md
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe("# Mine\n\nRun make lint.\n");
    expect(existsSync(join(repo, ".cursor/rules/pathrule-protocol.mdc"))).toBe(false);
    expect(readFileSync(join(repo, ".windsurfrules"), "utf8")).toBe(lost);
    expect(cleanup.knowledge.unclear.map((u) => u.path)).toEqual([".windsurfrules"]);
    expect(readFileSync(join(repo, ".cursorrules"), "utf8")).toBe(mine);
    // Detached again: nothing left to take out, and the unclear file is still only reported.
    const again = await clearDetachedFolder(entry(), env, { knowledge: true });
    expect(again.knowledge).toMatchObject({ removed: 0, stripped: 0, errors: [] });
    expect(again.knowledge.unclear.map((u) => u.path)).toEqual([".windsurfrules"]);
    expect(readFileSync(join(repo, ".windsurfrules"), "utf8")).toBe(lost);
  });

  it("keeps a Local folder's rendered files when asked to", async () => {
    const cleanup = await clearDetachedFolder(entry(), env, { knowledge: false });
    expect(cleanup.knowledge).toEqual({ removed: 0, stripped: 0, unclear: [], errors: [] });
    expect(existsSync(join(repo, ".claude/rules/pathrule/workspace.md"))).toBe(true);
  });

  it("keeps the cache while another attachment on this machine uses the workspace", async () => {
    await attachNativeWorkspace(
      "person-b",
      { workspace_id: "ws-cloud", organization_id: "org-1", name: "Shop", root: join(home, "b") },
      env,
    );
    const cleanup = await clearDetachedFolder(entry(), env, { knowledge: false });
    expect(cleanup.cache).toEqual({
      removed: 0,
      kept: "another attachment on this machine still uses it",
    });
    expect(existsSync(cache("hook-index.json"))).toBe(true);
  });

  it("never removes a Pathrule Local workspace's store", async () => {
    rmSync(join(home, "ws-cloud"), { recursive: true });
    const local = join(home, "local");
    mkdirSync(local);
    await initLocalWorkspace({ cwd: local, env, genWorkspaceId: () => "ws-cloud" });
    const cleanup = await clearDetachedFolder(entry(), env, { knowledge: false });
    expect(cleanup.cache.removed).toBe(0);
    expect(cleanup.cache.kept).toMatch(/is a Local workspace/);
    expect(existsSync(join(home, "ws-cloud", "pathrule.db"))).toBe(true);
  });
});
