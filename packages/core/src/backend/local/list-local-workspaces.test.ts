// SPDX-License-Identifier: Apache-2.0
// `LocalBackend.listLocalWorkspaces`: every local workspace of a Pathrule home, read the way
// discovery reads (read-only, no migration), with mirrors of hosted workspaces left out.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalBackend } from "./local-backend.js";

let dir: string;
let env: NodeJS.ProcessEnv;

function workspace(id: string, root: string, name?: string): void {
  mkdirSync(root, { recursive: true });
  const backend = LocalBackend.openForWorkspace(id, env);
  try {
    backend.registerWorkspace({ workspaceId: id, localRootPath: root, ...(name ? { name } : {}) });
  } finally {
    backend.close();
  }
}

beforeEach(() => {
  // realpath: macOS hands out /var/... for a directory that lives at /private/var/...
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-list-")));
  env = { PATHRULE_HOME: join(dir, ".pathrule") };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("LocalBackend.listLocalWorkspaces", () => {
  it("lists nothing for a home that does not exist yet", () => {
    expect(LocalBackend.listLocalWorkspaces(env)).toEqual([]);
  });

  it("lists every workspace with its name and root, sorted by name", () => {
    workspace("ws-b", join(dir, "beta"), "Beta");
    workspace("ws-a", join(dir, "alpha"), "Alpha");
    expect(LocalBackend.listLocalWorkspaces(env)).toEqual([
      { workspaceId: "ws-a", name: "Alpha", localRootPath: join(dir, "alpha") },
      { workspaceId: "ws-b", name: "Beta", localRootPath: join(dir, "beta") },
    ]);
  });

  it("names a workspace registered without a name after its folder", () => {
    workspace("ws-plain", join(dir, "plain-folder"));
    expect(LocalBackend.listLocalWorkspaces(env)).toEqual([
      { workspaceId: "ws-plain", name: "plain-folder", localRootPath: join(dir, "plain-folder") },
    ]);
  });

  it("never lists a mirror of a hosted workspace", () => {
    workspace("ws-local", join(dir, "local"), "Local");
    workspace("ws-mirror", join(dir, "hosted"), "Hosted");
    LocalBackend.markAsMirror("ws-mirror", env);
    expect(LocalBackend.listLocalWorkspaces(env).map((w) => w.workspaceId)).toEqual(["ws-local"]);
  });

  it("skips a store it cannot read and a folder that holds no store", () => {
    workspace("ws-ok", join(dir, "ok"), "Ok");
    mkdirSync(join(env.PATHRULE_HOME!, "not-a-store"), { recursive: true });
    mkdirSync(join(env.PATHRULE_HOME!, "garbage"), { recursive: true });
    writeFileSync(join(env.PATHRULE_HOME!, "garbage", "pathrule.db"), "not sqlite");
    expect(LocalBackend.listLocalWorkspaces(env).map((w) => w.workspaceId)).toEqual(["ws-ok"]);
  });

  it("agrees with discovery about which workspace a root belongs to", () => {
    workspace("ws-same", join(dir, "same"), "Same");
    const [listed] = LocalBackend.listLocalWorkspaces(env);
    const discovered = LocalBackend.discoverWorkspaceForCwd(join(dir, "same"), env);
    expect(listed).toMatchObject({
      workspaceId: discovered?.workspaceId,
      localRootPath: discovered?.localRootPath,
    });
  });
});
