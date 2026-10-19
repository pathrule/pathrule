// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// better-sqlite3 whose native module cannot load on this machine, as dlopen reports it.
vi.mock("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw Object.assign(new Error("dlopen(better_sqlite3.node): incompatible architecture"), {
        code: "ERR_DLOPEN_FAILED",
      });
    }
  },
}));

const { discoverWorkspaceStoreForCwd, listLocalWorkspaceStores } =
  await import("./workspace-stores.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace store discovery when SQLite cannot load", () => {
  it("reports the native failure instead of finding no workspace", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-stores-load-")));
    dirs.push(home);
    mkdirSync(join(home, "w1"));
    writeFileSync(join(home, "w1", "pathrule.db"), "");
    const env = { PATHRULE_HOME: home };
    expect(() => discoverWorkspaceStoreForCwd(home, env)).toThrow(/incompatible architecture/);
    expect(() => listLocalWorkspaceStores(env)).toThrow(/incompatible architecture/);
  });
});
