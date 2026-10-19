// SPDX-License-Identifier: Apache-2.0
// Regression: a signed-in person had to type `pathrule org use` and `pathrule attach` before a
// folder the machine already knew by its hook index reported anything to the Cloud.
// Regression (2026-10-19): the same binding attached a Pathrule Local workspace's folder to the Cloud
// workspace named like it, with nobody told. A folder set to Local, or one a Local workspace serves,
// is never bound automatically, and a folder's name binds nothing here (only `setup` and `init`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initLocalWorkspace } from "@pathrule/cli/local/init-local.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";

import {
  autoAttachFolder,
  autoAttachLine,
  folderModeHere,
  indexedFoldersFor,
  type AutoAttachRequest,
} from "./auto-attach.js";
import { attachNativeWorkspace, readNativeWorkspaces } from "./workspaces.js";

const USER = "person-1";
let home: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function index(workspaceId: string, root: string, generatedAt?: string) {
  const dir = join(home, "cache", workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hook-index.json"),
    JSON.stringify({
      schema_version: 2,
      workspace_id: workspaceId,
      workspace_root: root,
      ...(generatedAt ? { generated_at: generatedAt } : {}),
    }),
  );
}

/** The Cloud's tenancy routes, from a map of organization → workspaces. Counts its calls. */
function cloud(
  organizations: Record<string, Array<{ id: string; name: string }>>,
): AutoAttachRequest & { calls: string[] } {
  const calls: string[] = [];
  const request = (async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path === "/v1/organizations")
      return { items: Object.keys(organizations).map((id) => ({ id })) } as T;
    const m = path.match(/^\/v1\/organizations\/([^/]+)\/workspaces$/);
    if (m)
      return {
        items: (organizations[decodeURIComponent(m[1]!)] ?? []).map((w) => ({
          ...w,
          organization_id: decodeURIComponent(m[1]!),
        })),
      } as T;
    throw new Error(`unexpected ${path}`);
  }) as AutoAttachRequest & { calls: string[] };
  request.calls = calls;
  return request;
}

beforeEach(() => {
  // Canonical (macOS hands out /var/... for /private/var/...): attachments are stored canonical.
  home = realpathSync(mkdtempSync(join(tmpdir(), "pr-auto-attach-")));
  repo = join(home, "repo");
  mkdirSync(repo);
  // A build that names a Cloud, and an install that never chose: folders are Cloud folders.
  env = {
    PATHRULE_HOME: home,
    PATHRULE_LOCAL_PRINCIPAL: "tester",
    PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example.test",
    PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-test",
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("indexedFoldersFor", () => {
  it("lists the indexes at the nearest root, newest first", async () => {
    index("ws-old", repo, "2026-10-10T23:49:59.779Z");
    index("ws-new", repo, "2026-10-16T11:56:50.585Z");
    index("ws-parent", home);
    const folders = await indexedFoldersFor(join(repo, "packages", "x"), env);
    expect(folders.map((f) => f.workspaceId)).toEqual(["ws-new", "ws-old"]);
    expect(folders[0]!.root).toBe(repo);
    expect(await indexedFoldersFor("/nowhere/at/all", env)).toEqual([]);
  });
});

describe("autoAttachFolder", () => {
  it("attaches the folder to the workspace its hook index names, across organizations, at the index's root", async () => {
    index("ws-cloud", repo);
    const request = cloud({
      "org-a": [{ id: "ws-a", name: "other" }],
      "org-b": [{ id: "ws-cloud", name: "Repo" }],
    });
    const outcome = await autoAttachFolder({
      userId: USER,
      request,
      env,
      cwd: join(repo, "packages", "x"),
    });
    expect(outcome).toMatchObject({
      entry: { workspace_id: "ws-cloud", organization_id: "org-b", name: "Repo", root: repo },
    });
    expect(autoAttachLine(outcome!)).toBe(
      `Attached ${repo} to Pathrule Cloud workspace "Repo" (this machine's index for the folder names it).`,
    );
    expect(await readNativeWorkspaces(USER, env)).toHaveLength(1);
    // The organization was never "chosen": a workspace carries its own.
    expect(request.calls).toEqual([
      "/v1/organizations",
      "/v1/organizations/org-a/workspaces",
      "/v1/organizations/org-b/workspaces",
    ]);
  });

  it("prefers the index the hook serves (the newest) when a re-attachment left an older one", async () => {
    index("ws-old", repo, "2026-10-10T23:49:59.779Z");
    index("ws-new", repo, "2026-10-16T11:56:50.585Z");
    const request = cloud({
      org: [
        { id: "ws-old", name: "Repo" },
        { id: "ws-new", name: "Repo" },
      ],
    });
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toMatchObject({
      entry: { workspace_id: "ws-new" },
    });
  });

  it("binds nothing by a folder's name, and asks the Cloud nothing when no index names one", async () => {
    // A local-store index the Cloud does not know, and one workspace named like the folder.
    index("ws-local", repo);
    const request = cloud({
      org: [
        { id: "ws-named", name: "repo" },
        { id: "ws-x", name: "x" },
      ],
    });
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    expect(await readNativeWorkspaces(USER, env)).toEqual([]);
    const nothing = cloud({ org: [{ id: "ws-named", name: "repo" }] });
    rmSync(join(home, "cache"), { recursive: true });
    expect(await autoAttachFolder({ userId: USER, request: nothing, env, cwd: repo })).toBeNull();
    expect(nothing.calls).toEqual([]);
  });

  it("never binds a Pathrule Local workspace's folder, by its name or by an index", async () => {
    // Before 2026-10-19 this folder was attached to "ws-named" by its name.
    await initLocalWorkspace({ cwd: repo, env, genWorkspaceId: () => "ws-local" });
    expect(folderModeHere(repo, env)).toMatchObject({ mode: "local", source: "workspace" });
    index("ws-cloud", repo, "2099-01-01T00:00:00.000Z");
    const request = cloud({
      org: [
        { id: "ws-named", name: "repo" },
        { id: "ws-cloud", name: "Cloud" },
      ],
    });
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    // Chosen for Cloud, the folder keeps its Local workspace (dormant): still never bound here.
    recordFolderChoice(env, repo, "cloud", "setup");
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    expect(request.calls).toEqual([]);
    expect(await readNativeWorkspaces(USER, env)).toEqual([]);
  });

  it("never binds a folder set to Pathrule Local, or one under a root set to Local", async () => {
    index("ws-cloud", repo);
    const request = cloud({ org: [{ id: "ws-cloud", name: "repo" }] });
    recordFolderChoice(env, repo, "local", "setup");
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    // The subfolder chose Cloud, but the index would bind its parent, which chose Local.
    const sub = join(repo, "sub");
    mkdirSync(sub);
    recordFolderChoice(env, sub, "cloud", "setup");
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: sub })).toBeNull();
    expect(request.calls).toEqual([]);
    expect(await readNativeWorkspaces(USER, env)).toEqual([]);
  });

  it("never binds a folder on a machine whose default is Pathrule Local", async () => {
    mkdirSync(join(home, "capabilities"), { recursive: true });
    writeFileSync(
      join(home, "capabilities", "selection.json"),
      JSON.stringify({ schema: 1, setup: "local" }),
    );
    index("ws-cloud", repo);
    const request = cloud({ org: [{ id: "ws-cloud", name: "repo" }] });
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    expect(request.calls).toEqual([]);
  });

  it("leaves a folder whose index names a workspace the person cannot read", async () => {
    index("ws-gone", repo);
    const request = cloud({ org: [{ id: "ws-other", name: "repo" }] });
    expect(await autoAttachFolder({ userId: USER, request, env, cwd: repo })).toBeNull();
    expect(await readNativeWorkspaces(USER, env)).toEqual([]);
  });

  it("does nothing, and asks the Cloud nothing, for a folder already attached", async () => {
    await attachNativeWorkspace(
      USER,
      { workspace_id: "ws-1", organization_id: "org", name: "repo", root: repo },
      env,
    );
    const request = cloud({ org: [{ id: "ws-1", name: "repo" }] });
    expect(
      await autoAttachFolder({ userId: USER, request, env, cwd: join(repo, "deep") }),
    ).toBeNull();
    expect(request.calls).toEqual([]);
  });
});
