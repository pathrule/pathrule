// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { runKnowledgeBackendContract, CONTRACT_TEST_EMBED } from "../contract-suite.js";

// Same contract suite as the in-memory reference, now over real SQLite (:memory:).
// Green here = LocalBackend and the reference behave identically (parity).
// The deterministic embed seam enables the semantic-candidates parity block.
runKnowledgeBackendContract("LocalBackend (sqlite :memory:)", () => {
  let counter = 0;
  return new LocalBackend(":memory:", {
    genId: () => `id-${++counter}`,
    now: () => "2026-06-04T00:00:00.000Z",
    embed: CONTRACT_TEST_EMBED,
  });
});

// resolveWorkspaceFromCwd over the local `workspaces` rows
// (registerWorkspace is the OSS-init seam; not on the cross-edition interface).
describe("LocalBackend workspace resolution", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("maps a cwd under a registered root to a relative path; null when uncovered", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "ws-1", localRootPath: "/Users/me/repo" });
    expect(await b.resolveWorkspaceFromCwd("/Users/me/repo/src/api")).toEqual({
      workspaceId: "ws-1",
      localRootPath: "/Users/me/repo",
      relativePath: "/src/api",
    });
    expect((await b.resolveWorkspaceFromCwd("/Users/me/repo"))?.relativePath).toBe(""); // cwd === root
    expect(await b.resolveWorkspaceFromCwd("/Users/other/elsewhere")).toBeNull();
  });

  it("picks the LONGEST matching root (nested package wins over monorepo root)", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "root", localRootPath: "/repo" });
    b.registerWorkspace({ workspaceId: "nested", localRootPath: "/repo/packages/api" });
    const m = await b.resolveWorkspaceFromCwd("/repo/packages/api/src");
    expect(m?.workspaceId).toBe("nested");
    expect(m?.relativePath).toBe("/src");
  });

  // An isolated agent session runs in a git worktree, a checkout OUTSIDE the
  // canonical clone. Without a binding it resolves to no workspace and silently
  // loses every memory, rule and skill.
  it("resolves a cwd inside a registered worktree to its workspace", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "ws-1", localRootPath: "/Users/me/repo" });
    b.registerWorktreePath({
      workspaceId: "ws-1",
      localRootPath: "/Users/me/Pathrule/worktrees/repo/fix-badge-a1b2c3d4",
      branch: "fix-badge",
    });
    expect(
      await b.resolveWorkspaceFromCwd("/Users/me/Pathrule/worktrees/repo/fix-badge-a1b2c3d4/src"),
    ).toEqual({
      workspaceId: "ws-1",
      localRootPath: "/Users/me/Pathrule/worktrees/repo/fix-badge-a1b2c3d4",
      relativePath: "/src",
    });
    expect(b.listWorktreePaths()).toEqual([
      {
        workspaceId: "ws-1",
        localRootPath: "/Users/me/Pathrule/worktrees/repo/fix-badge-a1b2c3d4",
        branch: "fix-badge",
      },
    ]);
  });

  it("keeps the longest root winning when a nested clone sits inside a worktree", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "nested", localRootPath: "/wt/repo/packages/api" });
    b.registerWorktreePath({ workspaceId: "outer", localRootPath: "/wt/repo" });
    expect((await b.resolveWorkspaceFromCwd("/wt/repo/packages/api/src"))?.workspaceId).toBe(
      "nested",
    );
    expect((await b.resolveWorkspaceFromCwd("/wt/repo/docs"))?.workspaceId).toBe("outer");
  });

  it("stops resolving a worktree once its binding is removed", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "ws-1", localRootPath: "/Users/me/repo" });
    b.registerWorktreePath({ workspaceId: "ws-1", localRootPath: "/Users/me/wt/gone" });
    expect(await b.resolveWorkspaceFromCwd("/Users/me/wt/gone")).not.toBeNull();
    b.unregisterWorktreePath("/Users/me/wt/gone");
    expect(await b.resolveWorkspaceFromCwd("/Users/me/wt/gone")).toBeNull();
    expect(b.listWorktreePaths()).toEqual([]);
  });

  it("canonicalizes symlinked roots so init (one form) and resolve (another) agree", async () => {
    // Real symlinked dirs: register via the symlink path, resolve via a path under it.
    // Without realpath canonicalization the two forms wouldn't prefix-match.
    const realRoot = mkdtempSync(join(tmpdir(), "pathrule-real-"));
    const linkRoot = mkdtempSync(join(tmpdir(), "pathrule-link-")) + "/ws";
    tmps.push(realRoot, dirname(linkRoot));
    symlinkSync(realRoot, linkRoot);
    mkdirSync(join(realRoot, "src"));

    const b = new LocalBackend(":memory:");
    // init stores the symlinked form; resolve passes a path under the symlink too.
    b.registerWorkspace({ workspaceId: "ws-sym", localRootPath: linkRoot });
    const viaLink = await b.resolveWorkspaceFromCwd(join(linkRoot, "src"));
    expect(viaLink?.workspaceId).toBe("ws-sym");
    expect(viaLink?.relativePath).toBe("/src");
    // And resolving via the REAL (post-symlink) form also matches the same workspace.
    const viaReal = await b.resolveWorkspaceFromCwd(join(realRoot, "src"));
    expect(viaReal?.workspaceId).toBe("ws-sym");
    expect(viaReal?.relativePath).toBe("/src");
  });
});

describe("LocalBackend moveNodePath", () => {
  const make = () => {
    let n = 0;
    const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-06-24T00:00:00.000Z" });
    b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
    return b;
  };

  it("re-homes a folder node and its descendants, keeping attached content", async () => {
    const b = make();
    // /a/b carries a memory; /a is the folder we move.
    const leaf = await b.ensureNodeForPath("ws", "/a/b", "folder");
    const mem = await b.writeMemory({ workspaceId: "ws", nodeId: leaf.id, title: "T", content: "C" });

    const res = await b.moveNodePath("ws", "/a", "/c");
    expect(res.moved).toBe(true);

    const tree = await b.getTree("ws");
    const paths = tree.map((node) => node.relativePath).sort();
    expect(paths).toContain("/c");
    expect(paths).toContain("/c/b");
    expect(paths).not.toContain("/a");
    expect(paths).not.toContain("/a/b");

    // The memory is still attached to the (now repathed) leaf node.
    const movedLeaf = await b.findNodeByPath("ws", "/c/b");
    expect(movedLeaf?.id).toBe(leaf.id);
    const content = await b.getNodeContent(leaf.id);
    expect(content.memories.map((m) => m.id)).toContain(mem.id);
  });

  it("is a no-op when no node exists at the source path", async () => {
    const b = make();
    const res = await b.moveNodePath("ws", "/nope", "/dest");
    expect(res.moved).toBe(false);
  });

  it("moves a node back out to the workspace root", async () => {
    const b = make();
    const leaf = await b.ensureNodeForPath("ws", "/parent/child", "folder");
    const res = await b.moveNodePath("ws", "/parent/child", "/child");
    expect(res.moved).toBe(true);

    const moved = await b.findNodeByPath("ws", "/child");
    expect(moved?.id).toBe(leaf.id);
    const root = await b.findNodeByPath("ws", "/");
    const row = (await b.getTree("ws")).find((node) => node.id === leaf.id);
    expect(row?.parentId).toBe(root?.id);
  });
});
