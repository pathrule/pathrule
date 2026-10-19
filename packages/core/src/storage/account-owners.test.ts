// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearAccountOwner, readAccountOwners, recordAccountOwner } from "./account-owners.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-owners-"));
  env = { PATHRULE_HOME: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("account owners", () => {
  it("records one owner per provider, without a credential, in a private file", async () => {
    expect(await recordAccountOwner("native", "user-a", env)).toBeNull();
    expect(await readAccountOwners(env)).toMatchObject({ native: { user_id: "user-a" } });
    const raw = await readFile(join(home, "account-owners.json"), "utf8");
    expect(raw).not.toMatch(/token|secret|password/i);
    expect((await stat(join(home, "account-owners.json"))).mode & 0o777).toBe(0o600);
  });

  it("replaces the owner on an account switch and says whom it replaced", async () => {
    await recordAccountOwner("native", "user-a", env);
    expect(await recordAccountOwner("native", "user-b", env)).toBe("user-a");
    expect((await readAccountOwners(env)).native?.user_id).toBe("user-b");
  });

  it("clears one provider, or every provider on a sign-out everywhere", async () => {
    await recordAccountOwner("native", "user-a", env);
    await recordAccountOwner("other", "user-c", env);
    expect(await clearAccountOwner("native", env)).toEqual(["user-a"]);
    expect(Object.keys(await readAccountOwners(env))).toEqual(["other"]);
    expect(await clearAccountOwner(null, env)).toEqual(["user-c"]);
    expect(await readAccountOwners(env)).toEqual({});
  });

  it("reads nothing from a missing, corrupt or foreign file, and refuses bad names", async () => {
    expect(await readAccountOwners(env)).toEqual({});
    await writeFile(join(home, "account-owners.json"), "{not json");
    expect(await readAccountOwners(env)).toEqual({});
    await writeFile(
      join(home, "account-owners.json"),
      JSON.stringify({ schema_version: 1, owners: { "Bad Name": { user_id: "x" }, ok: {} } }),
    );
    expect(await readAccountOwners(env)).toEqual({});
    await expect(recordAccountOwner("Bad Name", "x", env)).rejects.toThrow(
      "invalid account provider",
    );
    await expect(recordAccountOwner("native", " ", env)).rejects.toThrow("needs a user id");
  });
});
