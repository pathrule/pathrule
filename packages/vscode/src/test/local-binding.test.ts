// SPDX-License-Identifier: Apache-2.0
// The local binding reaches the folder's store through the home's Pathrule host (open-core step
// 4h3): the running host, or one this extension host runs, which stops when the extension
// deactivates. It opens no store of its own.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHostRecord } from "@pathrule/host/discovery.js";
import { startHost } from "@pathrule/host/host.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFolderMode } from "../binding/folder-mode.js";
import { closeLocalBinding, localModeAvailable, openLocalBinding } from "../binding/local.js";

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-vscode-local-")));
  previousHome = process.env.PATHRULE_HOME;
  process.env.PATHRULE_HOME = join(root, ".pathrule");
});

afterEach(async () => {
  await closeLocalBinding();
  if (previousHome === undefined) delete process.env.PATHRULE_HOME;
  else process.env.PATHRULE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

/** The Local workspace the folder's edition names, as the extension reads it. */
async function localMatch(folder: string) {
  const edition = await readFolderMode(folder, process.env, {
    cloudAvailable: false,
    localAvailable: await localModeAvailable(),
  });
  return edition.mode === "local" ? edition.local : null;
}

/** A local workspace for `folder`, created through a host as `pathrule init --local` would. */
async function localWorkspace(folder: string): Promise<{ workspaceId: string; memoryId: string }> {
  mkdirSync(folder, { recursive: true });
  const host = await startHost({ env: process.env });
  try {
    const { initLocalWorkspace } = await import("@pathrule/host/workspace-init.js");
    const workspace = await initLocalWorkspace(
      { folder },
      { env: process.env, stores: host.stores, log: () => {} },
    );
    const memory = await host.stores
      .get(workspace.workspaceId)
      .writeMemory({ workspaceId: workspace.workspaceId, title: "A fact", content: "Kept." });
    return { workspaceId: workspace.workspaceId, memoryId: memory.id };
  } finally {
    await host.stop();
  }
}

describe("the VS Code local binding", () => {
  it("binds a folder to its local store through a host it runs, which stops with it", async () => {
    const folder = join(root, "project");
    const { workspaceId, memoryId } = await localWorkspace(folder);
    expect(await localModeAvailable()).toBe(true);

    const match = await localMatch(join(folder, "src"));
    expect(match).not.toBeNull();
    const binding = await openLocalBinding(match!);
    expect(binding).toMatchObject({
      kind: "local",
      workspaceId,
      localRootPath: folder,
      relativePath: "/src",
    });
    expect((await binding!.backend.readMemory(memoryId))?.content).toBe("Kept.");
    expect((await readHostRecord(process.env))?.pid).toBe(process.pid);

    await closeLocalBinding();
    expect(await readHostRecord(process.env)).toBeNull();
  });

  it("uses the host already serving the home, and leaves it running", async () => {
    const folder = join(root, "project");
    const { workspaceId, memoryId } = await localWorkspace(folder);
    const running = await startHost({ env: process.env });
    try {
      const binding = await openLocalBinding((await localMatch(folder))!);
      expect(binding?.workspaceId).toBe(workspaceId);
      expect((await binding!.backend.readMemory(memoryId))?.title).toBe("A fact");
      expect(running.stores.openWorkspaceIds()).toEqual([workspaceId]);
      await closeLocalBinding();
      expect((await readHostRecord(process.env))?.instance_id).toBe(running.record.instance_id);
    } finally {
      await running.stop();
    }
  });

  it("names no Local workspace for a folder none covers", async () => {
    expect(await localMatch(join(root, "elsewhere"))).toBeNull();
  });

  it("never loads SQLite in a runtime older than its Node-API: it would crash the extension host", async () => {
    const loaded = vi.fn();
    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      loaded();
      return { default: class {} };
    });
    const real = process.versions;
    Object.defineProperty(process, "versions", {
      value: { ...real, napi: "9" },
      configurable: true,
    });
    try {
      const fresh = await import("../binding/local.js");
      expect(await fresh.localModeAvailable()).toBe(false);
      expect(loaded).not.toHaveBeenCalled();
      await fresh.closeLocalBinding();
    } finally {
      Object.defineProperty(process, "versions", { value: real, configurable: true });
      vi.doUnmock("better-sqlite3");
      vi.resetModules();
    }
  });

  it("reports local mode unavailable when SQLite does not load in this runtime", async () => {
    const folder = join(root, "project");
    await localWorkspace(folder);
    const match = (await localMatch(folder))!;
    await closeLocalBinding();
    // A fresh copy of the binding whose better-sqlite3 cannot load its native module here.
    vi.resetModules();
    vi.doMock("better-sqlite3", () => ({
      default: class {
        constructor() {
          throw Object.assign(new Error("dlopen failed: incompatible architecture"), {
            code: "ERR_DLOPEN_FAILED",
          });
        }
      },
    }));
    try {
      const fresh = await import("../binding/local.js");
      expect(await fresh.localModeAvailable()).toBe(false);
      expect(await fresh.openLocalBinding(match)).toBeNull();
      expect(await readHostRecord(process.env)).toBeNull();
      await fresh.closeLocalBinding();
    } finally {
      vi.doUnmock("better-sqlite3");
      vi.resetModules();
    }
  });
});
