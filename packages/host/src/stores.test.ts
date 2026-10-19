// SPDX-License-Identifier: Apache-2.0
// The host's one store opener, on real SQLite stores in a scratch Pathrule home.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

import { scratchHome, type ScratchHome } from "./__fixtures__/helpers.js";
import { InvalidWorkspaceIdError, StoresClosedError, WorkspaceStores } from "./stores.js";

let home: ScratchHome;
let stores: WorkspaceStores;

beforeEach(() => {
  home = scratchHome();
  stores = new WorkspaceStores(home.env);
});

afterEach(() => {
  stores.closeAll();
  home.remove();
});

describe("WorkspaceStores", () => {
  it("opens the canonical store once and keeps it open", () => {
    const id = "6f1c2a8e-1b2c-4d3e-8f90-123456789abc";
    const first = stores.get(id);
    expect(stores.get(id)).toBe(first);
    expect(stores.openWorkspaceIds()).toEqual([id]);
    const db = join(home.env.PATHRULE_HOME!, id, "pathrule.db");
    expect(existsSync(db)).toBe(true);
    expect(statSync(db).mode & 0o777).toBe(0o600);
    first.registerWorkspace({ workspaceId: id, name: "w", localRootPath: home.dir });
  });

  it.each(["../escape", "a/b", "a\\b", ".hidden", "-flag", "", "x".repeat(129), "white space"])(
    "refuses the id %j before touching the disk",
    (id) => {
      expect(() => stores.get(id)).toThrow(InvalidWorkspaceIdError);
      expect(existsSync(home.env.PATHRULE_HOME!)).toBe(false);
    },
  );

  it("closes every store, and opens none after that", () => {
    const store = stores.get("ws-one");
    expect(stores.closeAll()).toEqual([]);
    expect(() =>
      store.registerWorkspace({ workspaceId: "ws-one", name: "w", localRootPath: home.dir }),
    ).toThrow(/not open/);
    expect(() => stores.get("ws-two")).toThrow(StoresClosedError);
    expect(stores.openWorkspaceIds()).toEqual([]);
  });

  it("reports a store that fails to close and still closes the others", () => {
    const closed: string[] = [];
    const custom = new WorkspaceStores(
      home.env,
      (id) =>
        ({
          close: () => {
            if (id === "bad") throw new Error("disk gone");
            closed.push(id);
          },
        }) as never,
    );
    custom.get("bad");
    custom.get("good");
    const failures = custom.closeAll();
    expect(failures.map((f) => f.message)).toEqual(["closing the store of bad: disk gone"]);
    expect(closed).toEqual(["good"]);
  });

  it("marks a store as a mirror, which local discovery then skips", () => {
    const id = "6f1c2a8e-1b2c-4d3e-8f90-123456789abd";
    const folder = join(home.dir, "mirrored");
    mkdirSync(folder, { recursive: true });
    stores.get(id).registerWorkspace({ workspaceId: id, localRootPath: folder });
    expect(LocalBackend.discoverWorkspaceForCwd(folder, home.env)?.workspaceId).toBe(id);

    stores.markMirror(id);
    expect(LocalBackend.isMirror(id, home.env)).toBe(true);
    expect(LocalBackend.discoverWorkspaceForCwd(folder, home.env)).toBeNull();
    expect(
      LocalBackend.discoverWorkspaceForCwd(folder, home.env, { includeMirrors: true })?.workspaceId,
    ).toBe(id);
    expect(() => stores.markMirror("../escape")).toThrow(InvalidWorkspaceIdError);
    stores.closeAll();
    expect(() => stores.markMirror(id)).toThrow(StoresClosedError);
  });
});
