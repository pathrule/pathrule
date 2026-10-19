// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverWorkspaceStoreForCwd, listLocalWorkspaceStores } from "../backend/local/workspace-stores.js";
import {
  clearDormantMark,
  isSetAside,
  markLocalStoreDormant,
  readDormantMark,
  removeCloudMachineCache,
  setAsideLocalStore,
} from "./local-store-markers.js";

let base: string;
let env: NodeJS.ProcessEnv;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "pr-store-markers-")));
  home = join(base, "home");
  env = { PATHRULE_HOME: home };
  mkdirSync(join(base, "repo"), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** A Local workspace store the way `pathrule init --local` leaves one: a workspace row with its folder. */
function localStore(id: string, root: string) {
  mkdirSync(join(home, id), { recursive: true });
  const db = new Database(join(home, id, "pathrule.db"));
  db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, local_root_path TEXT)");
  db.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(id, id, root);
  db.close();
}

describe("Local store markers", () => {
  it("never offers a store set aside to a folder again, and keeps it on disk", () => {
    localStore("local_a", join(base, "repo"));
    expect(discoverWorkspaceStoreForCwd(join(base, "repo"), env)?.workspaceId).toBe("local_a");
    setAsideLocalStore(env, "local_a", "shared its folder with a Pathrule Cloud workspace");
    expect(isSetAside(env, "local_a")).toBe(true);
    expect(discoverWorkspaceStoreForCwd(join(base, "repo"), env)).toBeNull();
    expect(listLocalWorkspaceStores(env)).toEqual([]);
    expect(existsSync(join(home, "local_a", "pathrule.db"))).toBe(true);
  });

  it("marks and clears a dormant Local store, which discovery still offers", () => {
    localStore("local_a", join(base, "repo"));
    markLocalStoreDormant(env, "local_a", "ws_cloud", new Date("2026-10-19T00:00:00.000Z"));
    expect(readDormantMark(env, "local_a")).toEqual({ since: "2026-10-19T00:00:00.000Z", cloud_workspace_id: "ws_cloud" });
    expect(discoverWorkspaceStoreForCwd(join(base, "repo"), env)?.workspaceId).toBe("local_a");
    clearDormantMark(env, "local_a");
    expect(readDormantMark(env, "local_a")).toBeNull();
  });

  it("removes a Cloud workspace's machine cache but keeps its unreported delivery receipts", () => {
    const cache = join(home, "cache", "ws_cloud");
    mkdirSync(join(cache, "deliveries"), { recursive: true });
    for (const f of ["hook-index.json", "user-words.jsonl", "ended-turns.jsonl", "deliveries-reported.json"]) writeFileSync(join(cache, f), "{}");
    mkdirSync(join(home, "ws_cloud"), { recursive: true });
    writeFileSync(join(home, "ws_cloud", "pathrule.db"), "");
    const removed = removeCloudMachineCache(env, "ws_cloud", () => false);
    expect(removed).toHaveLength(4);
    expect(existsSync(join(cache, "hook-index.json"))).toBe(false);
    expect(existsSync(join(cache, "user-words.jsonl"))).toBe(false);
    expect(existsSync(join(cache, "deliveries"))).toBe(true);
    expect(existsSync(join(cache, "deliveries-reported.json"))).toBe(true);
    expect(existsSync(join(home, "ws_cloud"))).toBe(false);
  });

  it("refuses to remove a Local workspace as if it were a Cloud cache", () => {
    localStore("local_a", join(base, "repo"));
    expect(() => removeCloudMachineCache(env, "local_a", (id) => id === "local_a")).toThrow(/is a Local workspace/);
    expect(existsSync(join(home, "local_a", "pathrule.db"))).toBe(true);
  });
});
