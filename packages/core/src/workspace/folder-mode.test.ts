// SPDX-License-Identifier: Apache-2.0
import { pathStartsWith } from "@pathrule/protocol/path-compare.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkspaceMatch } from "../backend/inputs.js";
import {
  folderChoicesPath,
  isCloudWorkspaceId,
  machineUsesCloud,
  readFolderChoices,
  recordFolderChoice,
  resolveFolderMode,
} from "./folder-mode.js";

let base: string;
let env: NodeJS.ProcessEnv;
let repos: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pr-folder-mode-")));
  env = { PATHRULE_HOME: join(base, "home") };
  repos = join(base, "repos");
  for (const dir of ["a", "a/b/c", "a/x", "solo", "other"]) mkdirSync(join(repos, dir), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const repo = (p: string) => join(repos, p);

function chooseDefault(mode: "cloud" | "local") {
  mkdirSync(join(base, "home", "capabilities"), { recursive: true });
  writeFileSync(
    join(base, "home", "capabilities", "selection.json"),
    JSON.stringify({ schema: 1, capabilities: mode === "cloud" ? ["cloud"] : [], setup: mode, source: "flag" }),
  );
}

function attachCloud(root: string, workspaceId: string, user = "u1") {
  const dir = join(base, "home", "config", "users", user);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "native-workspaces.json");
  let workspaces: unknown[] = [];
  try {
    workspaces = (JSON.parse(readFileSync(file, "utf8")) as { workspaces: unknown[] }).workspaces;
  } catch {
    workspaces = [];
  }
  workspaces.push({ workspace_id: workspaceId, organization_id: "org_1", name: workspaceId, root, attached_at: "2026-10-19T00:00:00.000Z" });
  writeFileSync(file, JSON.stringify({ schema_version: 1, workspaces }));
}

/** Local stores by root, served the way discovery serves them: the deepest root covering the cwd. */
function localStores(stores: Record<string, string>) {
  return (cwd: string): WorkspaceMatch | null => {
    let best: WorkspaceMatch | null = null;
    for (const [root, id] of Object.entries(stores)) {
      if (pathStartsWith(cwd, root) && (!best || root.length > best.localRootPath.length)) {
        best = { workspaceId: id, localRootPath: root, relativePath: cwd.slice(root.length).replace(/\\/g, "/") };
      }
    }
    return best;
  };
}

const cloudOn = { cloudAvailable: true };

describe("folder mode: the device default", () => {
  it("serves a folder with nothing of its own from Pathrule Cloud on a new install, and Local when the build names no Cloud", () => {
    const r = resolveFolderMode(repo("solo"), env, { ...cloudOn, discoverLocal: () => null });
    expect(r).toMatchObject({ mode: "cloud", source: "device-default", root: null, deviceDefault: { mode: "cloud", source: "new-install" } });
    const open = resolveFolderMode(repo("solo"), env, { cloudAvailable: false, discoverLocal: () => null });
    expect(open).toMatchObject({ mode: "local", deviceDefault: { source: "no-cloud" } });
  });

  it("follows the default the person chose", () => {
    chooseDefault("local");
    expect(resolveFolderMode(repo("solo"), env, { ...cloudOn, discoverLocal: () => null })).toMatchObject({
      mode: "local",
      source: "device-default",
      deviceDefault: { mode: "local", source: "chosen" },
    });
  });

  it("never changes a project that has its own workspace or choice when the default changes", () => {
    attachCloud(repo("a"), "ws_cloud_a");
    recordFolderChoice(env, repo("other"), "local", "setup");
    const discoverLocal = localStores({ [repo("solo")]: "local_solo" });
    const before = ["a", "other", "solo"].map((p) => resolveFolderMode(repo(p), env, { ...cloudOn, discoverLocal }).mode);
    chooseDefault("local");
    const afterLocal = ["a", "other", "solo"].map((p) => resolveFolderMode(repo(p), env, { ...cloudOn, discoverLocal }).mode);
    chooseDefault("cloud");
    const afterCloud = ["a", "other", "solo"].map((p) => resolveFolderMode(repo(p), env, { ...cloudOn, discoverLocal }).mode);
    expect(before).toEqual(["cloud", "local", "local"]);
    expect(afterLocal).toEqual(before);
    expect(afterCloud).toEqual(before);
  });
});

describe("folder mode: what serves a folder", () => {
  it("serves a folder with only a Local workspace locally, and one with only a Cloud attachment from the Cloud", () => {
    attachCloud(repo("other"), "ws_cloud");
    const discoverLocal = localStores({ [repo("solo")]: "local_solo" });
    expect(resolveFolderMode(repo("solo"), env, { ...cloudOn, discoverLocal })).toMatchObject({
      mode: "local",
      source: "workspace",
      local: { workspaceId: "local_solo" },
      cloud: null,
    });
    expect(resolveFolderMode(repo("other"), env, { ...cloudOn, discoverLocal })).toMatchObject({
      mode: "cloud",
      source: "workspace",
      cloud: { workspaceId: "ws_cloud" },
      local: null,
    });
  });

  it("refuses to guess when a folder has both and no choice", () => {
    attachCloud(repo("a"), "ws_cloud_a");
    const r = resolveFolderMode(repo("a/b"), env, { ...cloudOn, discoverLocal: localStores({ [repo("a")]: "local_a" }) });
    expect(r).toMatchObject({
      mode: null,
      source: "conflict",
      local: null,
      cloud: null,
      conflict: { root: repo("a"), localWorkspaceId: "local_a", cloudWorkspaceId: "ws_cloud_a" },
    });
  });

  it("serves a Cloud-chosen folder from the Cloud even when its Local store is still on disk, and the reverse", () => {
    attachCloud(repo("a"), "ws_cloud_a");
    const discoverLocal = localStores({ [repo("a")]: "local_a" });
    recordFolderChoice(env, repo("a"), "cloud", "setup");
    expect(resolveFolderMode(repo("a/b/c"), env, { ...cloudOn, discoverLocal })).toMatchObject({
      mode: "cloud",
      source: "project",
      cloud: { workspaceId: "ws_cloud_a" },
      local: null,
      dormant: { local: { workspaceId: "local_a" }, cloud: null },
    });
    recordFolderChoice(env, repo("a"), "local", "setup");
    expect(resolveFolderMode(repo("a/b/c"), env, { ...cloudOn, discoverLocal })).toMatchObject({
      mode: "local",
      local: { workspaceId: "local_a" },
      cloud: null,
      dormant: { cloud: { workspaceId: "ws_cloud_a" } },
    });
    expect(readFolderChoices(env)).toHaveLength(1);
  });

  it("keeps a Cloud folder on the Cloud with no Cloud workspace to serve it: never the Local store instead", () => {
    recordFolderChoice(env, repo("a"), "cloud", "setup");
    const r = resolveFolderMode(repo("a"), env, { ...cloudOn, discoverLocal: localStores({ [repo("a")]: "local_a" }) });
    expect(r).toMatchObject({ mode: "cloud", cloud: null, local: null });
  });

  it("lets the deepest folder decide, so a nested project keeps its own edition", () => {
    attachCloud(repo("a"), "ws_cloud_a");
    const discoverLocal = localStores({ [repo("a/b")]: "local_b" });
    expect(resolveFolderMode(repo("a/b/c"), env, { ...cloudOn, discoverLocal })).toMatchObject({ mode: "local", root: repo("a/b") });
    expect(resolveFolderMode(repo("a/x"), env, { ...cloudOn, discoverLocal })).toMatchObject({ mode: "cloud", root: repo("a") });
    recordFolderChoice(env, repo("a/b/c"), "cloud", "setup");
    expect(resolveFolderMode(repo("a/b/c"), env, { ...cloudOn, discoverLocal })).toMatchObject({ mode: "cloud", source: "project" });
  });

  it("never treats a store named by a Cloud workspace id as a Local workspace", () => {
    attachCloud(repo("other"), "ws_cloud_x");
    const r = resolveFolderMode(repo("solo"), env, { ...cloudOn, discoverLocal: localStores({ [repo("solo")]: "ws_cloud_x" }) });
    expect(r).toMatchObject({ mode: "cloud", source: "device-default", local: null });
    expect(isCloudWorkspaceId("ws_cloud_x", env)).toBe(true);
    expect(isCloudWorkspaceId("local_solo", env)).toBe(false);
  });

  it("reads every person's attachments, so a signed-out person's Cloud folder stays a Cloud folder", () => {
    attachCloud(repo("a"), "ws_one", "user_one");
    attachCloud(repo("other"), "ws_two", "user_two");
    expect(resolveFolderMode(repo("other"), env, { ...cloudOn, discoverLocal: () => null }).cloud?.workspaceId).toBe("ws_two");
  });
});

describe("folder mode: recorded choices", () => {
  it("stores one choice per folder, by the folder's real path", () => {
    symlinkSync(repo("solo"), join(base, "link"));
    recordFolderChoice(env, join(base, "link"), "local", "init");
    recordFolderChoice(env, repo("solo"), "cloud", "setup");
    expect(readFolderChoices(env)).toEqual([expect.objectContaining({ root: repo("solo"), mode: "cloud", via: "setup" })]);
    expect(folderChoicesPath(env)).toBe(join(base, "home", "capabilities", "folders.json"));
  });

  it("says whether the machine uses Pathrule Cloud at all", () => {
    chooseDefault("local");
    expect(machineUsesCloud(env, cloudOn)).toBe(false);
    recordFolderChoice(env, repo("a"), "cloud", "setup");
    expect(machineUsesCloud(env, cloudOn)).toBe(true);
  });
});
