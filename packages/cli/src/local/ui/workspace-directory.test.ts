// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WORKSPACE_FAVORITES_MAX } from "@pathrule/protocol/workspace-summary.js";

import {
  favoritesFile,
  FavoritesFullError,
  glanceWorkspaces,
  readFavorites,
  setFavorite,
} from "./workspace-directory.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pathrule-favorites-"));
  env = { PATHRULE_HOME: join(dir, ".pathrule") };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("this machine's favorite workspaces", () => {
  it("are none before anything is marked, or when the file is unreadable", async () => {
    expect(await readFavorites(env)).toEqual([]);
    await setFavorite(env, "a", true, new Set(["a"]));
    writeFileSync(favoritesFile(env), "{not json");
    expect(await readFavorites(env)).toEqual([]);
  });

  it("keep the order they were marked in, once each, in a file only the owner reads", async () => {
    const known = new Set(["a", "b", "c"]);
    await setFavorite(env, "b", true, known);
    await setFavorite(env, "a", true, known);
    expect(await setFavorite(env, "b", true, known)).toEqual(["b", "a"]);
    expect(await setFavorite(env, "b", false, known)).toEqual(["a"]);
    expect(await setFavorite(env, "c", false, known)).toEqual(["a"]);
    expect(JSON.parse(readFileSync(favoritesFile(env), "utf8"))).toEqual({
      version: 1,
      workspaces: ["a"],
    });
    if (process.platform !== "win32") expect(statSync(favoritesFile(env)).mode & 0o777).toBe(0o600);
  });

  it("drop workspaces that are gone, and refuse one past the limit", async () => {
    const all = Array.from({ length: WORKSPACE_FAVORITES_MAX + 1 }, (_, i) => `w${i}`);
    const known = new Set(all);
    mkdirSync(env.PATHRULE_HOME!, { recursive: true });
    const write = (ids: string[]) =>
      writeFileSync(favoritesFile(env), JSON.stringify({ version: 1, workspaces: ids }));
    write(["gone", "w0"]);
    expect(await setFavorite(env, "w1", true, known)).toEqual(["w0", "w1"]);
    write(all.slice(0, -1));
    await expect(setFavorite(env, all.at(-1)!, true, known)).rejects.toBeInstanceOf(
      FavoritesFullError,
    );
    expect(await setFavorite(env, "w0", false, known)).toHaveLength(WORKSPACE_FAVORITES_MAX - 1);
  });

  it("lose no change when two consoles mark at once", async () => {
    const known = new Set(["a", "b", "c", "d"]);
    await Promise.all(["a", "b", "c", "d"].map((id) => setFavorite(env, id, true, known)));
    expect([...(await readFavorites(env))].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("glancing at many workspaces", () => {
  it("keeps their order and leaves out one that cannot be read", async () => {
    const read = async (id: string) => {
      if (id === "broken") throw new Error("store closed");
      return {
        id,
        items: { memory: 0, rule: 0, skill: 0 },
        lastActivityAt: null,
        deliveries: [],
        previousDeliveries: 0,
        activeSignals: null,
      };
    };
    const ids = ["a", "broken", "b", "c", "d", "e"];
    expect((await glanceWorkspaces(ids, read)).map((entry) => entry.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(await glanceWorkspaces([], read)).toEqual([]);
  });
});
