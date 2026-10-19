// SPDX-License-Identifier: Apache-2.0
// The folder's binding follows its edition, read by the resolver every Pathrule surface uses
// (core's resolveFolderMode) in a scratch home: Cloud attachments and folder choices on disk,
// Local stores through the resolver's discovery seam. A Cloud folder is never served from a Local
// store, and a folder in conflict binds neither.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkspaceMatch } from "@pathrule/core/backend/inputs.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFolderMode } from "../binding/folder-mode.js";
import { BindingManager } from "../binding/manager.js";
import {
  resolveFolderBinding,
  unboundReason,
  type BindingDeps,
  type BoundFolder,
  type FolderBinding,
  type FolderEdition,
} from "../binding/types.js";

let root: string;
let env: NodeJS.ProcessEnv;
let localStores: Map<string, string>;
let cloudAttachments: Array<{
  workspace_id: string;
  organization_id: string;
  name: string;
  root: string;
}>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-vscode-binding-")));
  env = { PATHRULE_HOME: join(root, ".pathrule") };
  localStores = new Map();
  cloudAttachments = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A Local store serving `at`, as the resolver's discovery reports it. */
function localStore(at: string, workspaceId: string): void {
  localStores.set(at, workspaceId);
}

/** `at` attached to a Pathrule Cloud workspace, as packages/cloud writes it. */
function attachCloud(at: string, workspaceId: string, name: string): void {
  cloudAttachments.push({ workspace_id: workspaceId, organization_id: "org-1", name, root: at });
  const dir = join(root, ".pathrule", "config", "users", "user-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "native-workspaces.json"),
    JSON.stringify({ schema_version: 1, workspaces: cloudAttachments }),
  );
}

function discoverLocal(cwd: string): WorkspaceMatch | null {
  let best: string | null = null;
  for (const at of localStores.keys()) {
    if ((cwd === at || cwd.startsWith(`${at}/`)) && (!best || at.length > best.length)) best = at;
  }
  if (!best) return null;
  return {
    workspaceId: localStores.get(best)!,
    localRootPath: best,
    relativePath: cwd === best ? "" : cwd.slice(best.length),
  };
}

const opened = { local: [] as WorkspaceMatch[], cloud: [] as string[] };

function bound(
  kind: "cloud" | "local",
  workspaceId: string,
  localRootPath: string,
  relativePath: string,
): BoundFolder {
  return {
    kind,
    backend: {} as BoundFolder["backend"],
    workspaceId,
    workspaceName: null,
    localRootPath,
    relativePath,
  };
}

function deps(
  over: Partial<BindingDeps> & {
    signedIn?: boolean;
    cloudResolves?: string;
    sqlite?: boolean;
  } = {},
): BindingDeps {
  opened.local = [];
  opened.cloud = [];
  const { signedIn = false, cloudResolves, sqlite = true, ...rest } = over;
  return {
    resolveMode: (f) =>
      readFolderMode(f, env, { cloudAvailable: true, localAvailable: sqlite, discoverLocal }),
    openLocal: async (match) => {
      opened.local.push(match);
      return bound("local", match.workspaceId, match.localRootPath, match.relativePath);
    },
    openCloud: async (f) => {
      opened.cloud.push(f);
      const attached = cloudAttachments.find((a) => f === a.root || f.startsWith(`${a.root}/`));
      if (!attached) return null;
      return bound(
        "cloud",
        cloudResolves ?? attached.workspace_id,
        attached.root,
        f.slice(attached.root.length),
      );
    },
    cloudAvailable: async () => true,
    hasSession: async () => signedIn,
    localAvailable: async () => sqlite,
    adoptableAccount: async () => null,
    ...rest,
  };
}

describe("resolveFolderBinding: the folder's edition decides", () => {
  it("a Local folder binds its Local workspace", async () => {
    const project = folder("project");
    folder("project", "src");
    localStore(project, "local-ws");
    const binding = await resolveFolderBinding(join(project, "src"), deps());
    expect(binding).toMatchObject({
      kind: "local",
      workspaceId: "local-ws",
      localRootPath: project,
      relativePath: "/src",
    });
    expect(opened.cloud).toEqual([]);
  });

  it("a Cloud folder signed out asks to sign in, and is never served from its Local store", async () => {
    const project = folder("project");
    localStore(project, "local-ws");
    attachCloud(project, "cloud-ws", "Acme");
    recordFolderChoice(env, project, "cloud", "setup");
    const binding = await resolveFolderBinding(project, deps({ signedIn: false }));
    expect(binding).toMatchObject({
      kind: "unbound",
      mode: "cloud",
      reason: "signed-out",
      cloudWorkspace: { id: "cloud-ws", name: "Acme" },
    });
    expect(opened.local).toEqual([]);
    expect(opened.cloud).toEqual([]);

    // Signed in, it binds the Cloud workspace it is attached to.
    expect(await resolveFolderBinding(project, deps({ signedIn: true }))).toMatchObject({
      kind: "cloud",
      workspaceId: "cloud-ws",
    });
  });

  it("a folder nothing serves follows the device default, Pathrule Cloud on a new install", async () => {
    const project = folder("project");
    // A Local store elsewhere on the machine serves another project, never this one.
    localStore(folder("other"), "other-ws");
    const binding = await resolveFolderBinding(project, deps({ signedIn: true }));
    expect(binding).toMatchObject({ kind: "unbound", mode: "cloud", reason: "not-set-up" });
    expect(opened.local).toEqual([]);
  });

  it("a folder with both workspaces and no choice is a conflict, with the sentence every surface shows", async () => {
    const project = folder("project");
    localStore(project, "local-ws");
    attachCloud(project, "cloud-ws", "Acme");
    const binding = await resolveFolderBinding(project, deps({ signedIn: true }));
    expect(binding).toMatchObject({ kind: "unbound", mode: null, reason: "conflict" });
    if (binding.kind !== "unbound") throw new Error("bound");
    expect(binding.conflict?.root).toBe(project);
    expect(binding.conflict?.message).toContain(
      "both a Pathrule Local workspace and a Pathrule Cloud workspace",
    );
    expect(opened.local).toEqual([]);
    expect(opened.cloud).toEqual([]);

    // The person's choice for the folder settles it.
    recordFolderChoice(env, project, "local", "vscode");
    expect(await resolveFolderBinding(project, deps({ signedIn: true }))).toMatchObject({
      kind: "local",
      workspaceId: "local-ws",
    });
  });

  it("a nested project keeps its own edition inside a Cloud folder", async () => {
    const repo = folder("repo");
    const tool = folder("repo", "tools", "cli");
    folder("repo", "tools", "cli", "src");
    folder("repo", "web");
    attachCloud(repo, "cloud-ws", "Acme");
    localStore(tool, "tool-ws");
    expect(await resolveFolderBinding(join(tool, "src"), deps({ signedIn: true }))).toMatchObject({
      kind: "local",
      workspaceId: "tool-ws",
      relativePath: "/src",
    });
    expect(await resolveFolderBinding(join(repo, "web"), deps({ signedIn: true }))).toMatchObject({
      kind: "cloud",
      workspaceId: "cloud-ws",
      relativePath: "/web",
    });
  });

  it("never binds a Cloud workspace other than the one the folder is attached to", async () => {
    const project = folder("project");
    attachCloud(project, "cloud-ws", "Acme");
    const binding = await resolveFolderBinding(
      project,
      deps({ signedIn: true, cloudResolves: "other-ws" }),
    );
    expect(binding).toMatchObject({ kind: "unbound", mode: "cloud", reason: "cloud-unreachable" });
  });

  it("tells why a Cloud folder's workspace did not open, and never serves its Local store instead", async () => {
    const project = folder("project");
    // A Local store on the same folder, kept and unused: it must never be the answer.
    localStore(project, "local-ws");
    attachCloud(project, "cloud-ws", "Acme");
    recordFolderChoice(env, project, "cloud", "setup");
    for (const cause of ["offline", "access-denied", "cloud-error"] as const) {
      const binding = await resolveFolderBinding(
        project,
        deps({ signedIn: true, openCloud: async () => null, cloudFailure: async () => cause }),
      );
      expect(binding).toMatchObject({ kind: "unbound", mode: "cloud", reason: "cloud-unreachable", cloudFailure: cause });
      expect(opened.local).toEqual([]);
    }
    // A session the Cloud no longer accepts is a sign-in, not an outage.
    const expired = await resolveFolderBinding(
      project,
      deps({ signedIn: true, openCloud: async () => null, cloudFailure: async () => "signed-out" }),
    );
    expect(expired).toMatchObject({ kind: "unbound", reason: "signed-out" });
    expect(expired).not.toHaveProperty("cloudFailure");
    // A cause that cannot be read leaves the general wording.
    const unknown = await resolveFolderBinding(
      project,
      deps({ signedIn: true, openCloud: async () => null, cloudFailure: async () => { throw new Error("x"); } }),
    );
    expect(unknown).toMatchObject({ kind: "unbound", reason: "cloud-unreachable" });
    expect(unknown).not.toHaveProperty("cloudFailure");
    expect(opened.local).toEqual([]);
  });

  it("a Local folder where SQLite cannot run says so, and is not served from the Cloud", async () => {
    const project = folder("project");
    attachCloud(folder("elsewhere"), "cloud-ws", "Acme");
    recordFolderChoice(env, project, "local", "setup");
    const binding = await resolveFolderBinding(project, deps({ sqlite: false, signedIn: true }));
    expect(binding).toMatchObject({ kind: "unbound", mode: "local", reason: "local-unavailable" });
    expect(opened.cloud).toEqual([]);
  });

  it("a build without Pathrule Cloud names a Cloud folder unavailable instead of binding Local", async () => {
    const project = folder("project");
    localStore(project, "local-ws");
    attachCloud(project, "cloud-ws", "Acme");
    recordFolderChoice(env, project, "cloud", "setup");
    const binding = await resolveFolderBinding(
      project,
      deps({ signedIn: true, cloudAvailable: async () => false }),
    );
    expect(binding).toMatchObject({ kind: "unbound", mode: "cloud", reason: "cloud-unavailable" });
    expect(opened.local).toEqual([]);
  });
});

describe("unboundReason", () => {
  const state = { hasSession: true, localAvailable: true, cloudAvailable: true };
  const cloud = { workspaceId: "w", organizationId: "o", name: "n", root: "/r" };
  const local = { workspaceId: "l", localRootPath: "/r", relativePath: "" };

  it("names what the person can act on, never the other edition", () => {
    expect(unboundReason({ mode: null, local: null, cloud: null }, state)).toBe("conflict");
    expect(unboundReason({ mode: "local", local: null, cloud: null }, state)).toBe("not-set-up");
    expect(unboundReason({ mode: "local", local, cloud: null }, state)).toBe("local-unavailable");
    expect(
      unboundReason(
        { mode: "local", local: null, cloud: null },
        { ...state, localAvailable: false },
      ),
    ).toBe("local-unavailable");
    expect(unboundReason({ mode: "cloud", local: null, cloud: null }, state)).toBe("not-set-up");
    expect(
      unboundReason({ mode: "cloud", local: null, cloud }, { ...state, hasSession: false }),
    ).toBe("signed-out");
    expect(unboundReason({ mode: "cloud", local: null, cloud }, state)).toBe("cloud-unreachable");
    expect(
      unboundReason({ mode: "cloud", local: null, cloud }, { ...state, cloudAvailable: false }),
    ).toBe("cloud-unavailable");
  });
});

describe("BindingManager", () => {
  const edition = (over: Partial<FolderEdition> = {}): FolderEdition => ({
    cwd: "/repo",
    mode: "local",
    source: "workspace",
    root: "/repo",
    deviceDefault: { mode: "cloud", source: "new-install" },
    local: { workspaceId: "ws-1", localRootPath: "/repo", relativePath: "/apps/web" },
    cloud: null,
    dormant: { local: null, cloud: null },
    conflict: null,
    conflictMessage: null,
    ...over,
  });
  const fakes = (over: Partial<BindingDeps> = {}): BindingDeps => ({
    resolveMode: async () => edition(),
    openLocal: async (m) => bound("local", m.workspaceId, m.localRootPath, m.relativePath),
    openCloud: async () => null,
    cloudAvailable: async () => true,
    hasSession: async () => false,
    localAvailable: async () => true,
    adoptableAccount: async () => null,
    ...over,
  });

  it("starts null (resolving) and notifies on revalidate", async () => {
    const seen: Array<FolderBinding | null> = [];
    const manager = new BindingManager("/repo", fakes());
    manager.onDidChange((b) => seen.push(b));
    expect(manager.current()).toBeNull();
    await manager.revalidate();
    expect(manager.current()?.kind).toBe("local");
    expect(seen).toHaveLength(1);
  });

  it("no folder → resolves to null binding", async () => {
    const manager = new BindingManager(null, fakes());
    expect(await manager.revalidate()).toBeNull();
    expect(await manager.folderEdition()).toBeNull();
  });

  it("resolution failure degrades to an unbound folder to retry, never throws", async () => {
    const manager = new BindingManager(
      "/repo",
      fakes({
        resolveMode: async () => {
          throw new Error("unreadable home");
        },
      }),
    );
    expect(await manager.revalidate()).toMatchObject({
      kind: "unbound",
      mode: null,
      reason: "failed",
    });
  });

  it("drops stale async results (sequence guard)", async () => {
    let release!: (v: FolderEdition) => void;
    const slow = new Promise<FolderEdition>((r) => (release = r));
    let call = 0;
    const manager = new BindingManager(
      "/repo",
      fakes({
        resolveMode: () =>
          ++call === 1
            ? slow
            : Promise.resolve(
                edition({
                  mode: "cloud",
                  local: null,
                  cloud: { workspaceId: "ws-c", organizationId: "o", name: "Acme", root: "/repo" },
                }),
              ),
        hasSession: async () => true,
        openCloud: async () => bound("cloud", "ws-c", "/repo", ""),
      }),
    );
    const first = manager.revalidate();
    const second = manager.revalidate();
    release(edition()); // stale slow result arrives after the second call
    await Promise.all([first, second]);
    expect(manager.current()?.kind).toBe("cloud");
  });
});
