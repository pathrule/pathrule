// SPDX-License-Identifier: Apache-2.0
//
// A MIRROR store must not be mistaken for a workspace store.
//
// Both look identical on disk: same path shape, same schema, a `local_root_path` pointing at
// the same folder. They mean opposite things. A workspace store is the authority for its
// content; a mirror is a local copy of an authority that lives elsewhere, kept so that work
// survives while that authority is unreachable.
//
// `discoverWorkspaceForCwd` scans every store under PATHRULE_HOME and returns any whose
// `local_root_path` covers the cwd, and callers ask it FIRST to decide which backend serves a
// folder. Without a way to tell the two apart, one mirrored write is enough to make that
// question answer "yes, this is a local workspace" for a folder whose authority is somewhere
// else: reads then come from a partial copy, and writes land in it with nothing behind them.
//
// So a mirror is marked, discovery skips marked stores, and the callers that genuinely want
// the mirror (resolving a cwd through the mirror's own registry while the authority is
// unreachable) ask for it explicitly.

import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "./local-backend.js";

const CLOUD_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const LOCAL_WORKSPACE = "55555555-5555-4555-8555-555555555555";

let home: string;
let repo: string;
const open: LocalBackend[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-shadow-"));
  repo = await mkdtemp(join(tmpdir(), "pathrule-repo-"));
  // A REAL subdirectory: discovery canonicalizes the cwd through realpath, and on macOS a
  // temp path is a symlink, so a cwd that does not exist on disk cannot be canonicalized
  // and would never match its own root. That is a test artifact, not a product rule.
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  process.env.PATHRULE_HOME = home;
});

afterEach(() => {
  for (const backend of open.splice(0)) {
    try {
      backend.close();
    } catch {
      /* already closed */
    }
  }
  delete process.env.PATHRULE_HOME;
});

/** A mirror: the store the MCP server opens under the CLOUD workspace id during an outage. */
function openMirror(): LocalBackend {
  const backend = LocalBackend.openForWorkspace(CLOUD_WORKSPACE, process.env);
  open.push(backend);
  backend.registerWorkspace({
    workspaceId: CLOUD_WORKSPACE,
    name: "mirrored",
    localRootPath: repo,
  });
  LocalBackend.markAsMirror(CLOUD_WORKSPACE, process.env);
  return backend;
}

/** A genuine local-edition workspace: `pathrule init --local` in a folder. */
function openLocalEdition(): LocalBackend {
  const backend = LocalBackend.openForWorkspace(LOCAL_WORKSPACE, process.env);
  open.push(backend);
  backend.registerWorkspace({
    workspaceId: LOCAL_WORKSPACE,
    name: "local",
    localRootPath: repo,
  });
  return backend;
}

describe("mirror stores and discovery", () => {
  it("does not offer a mirror as a local workspace for the cwd", async () => {
    openMirror();
    // This is the assertion that fails on the pre-fix code: discovery returned the mirror,
    // so the agent gateway took the local branch and never reached the cloud.
    expect(LocalBackend.discoverWorkspaceForCwd(repo, process.env)).toBeNull();
    expect(LocalBackend.discoverWorkspaceForCwd(join(repo, "packages/app"), process.env)).toBeNull();
  });

  it("still offers a genuine local-edition workspace", async () => {
    openLocalEdition();
    const match = LocalBackend.discoverWorkspaceForCwd(join(repo, "packages/app"), process.env);
    expect(match?.workspaceId).toBe(LOCAL_WORKSPACE);
  });

  it("prefers the local edition when a mirror covers the same folder", async () => {
    // Both stores claim the same root. The local-edition one is the user's own workspace;
    // the mirror is a cache of someone else's authority.
    openMirror();
    openLocalEdition();
    const match = LocalBackend.discoverWorkspaceForCwd(repo, process.env);
    expect(match?.workspaceId).toBe(LOCAL_WORKSPACE);
  });

  it("can be asked for mirrors on purpose", async () => {
    // The offline write path DOES want the mirror: it resolves the cwd through the mirror's
    // own registry when the cloud cannot answer. Skipping mirrors everywhere would break
    // the case the mirror was built for, so the skip is a caller decision.
    openMirror();
    const match = LocalBackend.discoverWorkspaceForCwd(repo, process.env, {
      includeMirrors: true,
    });
    expect(match?.workspaceId).toBe(CLOUD_WORKSPACE);
  });

  it("marks the store on disk, not in memory", async () => {
    // A marker that lived in the process would be gone by the next launch, which is exactly
    // when discovery runs and exactly when the shadowing happened.
    openMirror();
    const entries = await readdir(join(home, CLOUD_WORKSPACE));
    expect(entries).toContain(".mirror");
  });

  it("is idempotent and survives a store that was already a mirror", async () => {
    openMirror();
    expect(() => LocalBackend.markAsMirror(CLOUD_WORKSPACE, process.env)).not.toThrow();
    expect(LocalBackend.discoverWorkspaceForCwd(repo, process.env)).toBeNull();
  });
});
