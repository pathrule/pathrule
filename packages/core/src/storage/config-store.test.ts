// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearActiveUserPointer,
  readUserConfig,
  updateUserConfig,
  writeActiveUserPointer,
} from "./config-store.js";
import { localRuntimePaths, userRuntimePaths } from "./paths.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pathrule-config-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local runtime config store", () => {
  it("reads missing config as schema v1 and writes owner-only files", async () => {
    const env = { PATHRULE_HOME: root };
    await expect(readUserConfig("user-1", env)).resolves.toEqual({ schema_version: 1 });

    await updateUserConfig("user-1", { current_org_id: "org-1" }, env);
    const paths = userRuntimePaths("user-1", 0, env);
    expect(JSON.parse(await readFile(paths.userConfigFile, "utf8"))).toMatchObject({
      schema_version: 1,
      current_org_id: "org-1",
    });
    expect((await stat(paths.userConfigFile)).mode & 0o777).toBe(0o600);
  });

  it("writes and clears active user pointer", async () => {
    const env = { PATHRULE_HOME: root };
    await writeActiveUserPointer("user-1", env);
    const paths = localRuntimePaths(env);
    expect(JSON.parse(await readFile(paths.activeUserFile, "utf8"))).toMatchObject({
      user_id: "user-1",
    });

    await clearActiveUserPointer(env);
    await expect(stat(paths.activeUserFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
