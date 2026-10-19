// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  discoverWorkspaceStoreForCwd,
  isSqliteLoadFailure,
  listLocalWorkspaceStores,
} from "./workspace-stores.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-stores-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A home with one store whose workspace covers `root`. */
function homeWithStore(root: string): string {
  const home = tempDir();
  mkdirSync(join(home, "w1"));
  const db = new Database(join(home, "w1", "pathrule.db"));
  db.exec("CREATE TABLE workspaces (id TEXT, name TEXT, local_root_path TEXT)");
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'one', ?)").run(root);
  db.close();
  return home;
}

describe("workspace store discovery", () => {
  it("still skips a store that is not a database", () => {
    const root = tempDir();
    const home = homeWithStore(root);
    mkdirSync(join(home, "w2"));
    writeFileSync(join(home, "w2", "pathrule.db"), "not a database");
    expect(discoverWorkspaceStoreForCwd(root, { PATHRULE_HOME: home })?.workspaceId).toBe("w1");
    expect(listLocalWorkspaceStores({ PATHRULE_HOME: home }).map((w) => w.workspaceId)).toEqual([
      "w1",
    ]);
  });

  it("recognises the loader's failures and nothing else", () => {
    expect(
      isSqliteLoadFailure(
        Object.assign(new Error("Cannot find module '/x/build/Release/better_sqlite3.node'"), {
          code: "MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(true);
    expect(
      isSqliteLoadFailure(
        Object.assign(new Error("Cannot find module './other.js'"), { code: "MODULE_NOT_FOUND" }),
      ),
    ).toBe(false);
    expect(
      isSqliteLoadFailure(Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" })),
    ).toBe(true);
    expect(isSqliteLoadFailure(new Error("file is not a database"))).toBe(false);
    expect(isSqliteLoadFailure("NODE_MODULE_VERSION")).toBe(false);
  });
});
