// SPDX-License-Identifier: Apache-2.0
// The local file and the in-memory reference meet one UserKnowledgeStore contract, and the file
// store keeps the file every other reader and writer uses.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryUserKnowledgeStore,
  type UserKnowledgeStore,
} from "./user-knowledge-persistence.js";
import {
  createFileUserKnowledgeStore,
  deleteUserKnowledge,
  readUserKnowledge,
  userKnowledgeLedgerPath,
  userKnowledgePath,
} from "./user-knowledge-store.js";
import {
  runUserKnowledgeStoreContract,
  stampedUserKnowledgeFixture,
} from "./user-knowledge-store-contract.js";

runUserKnowledgeStoreContract("in-memory reference", async () => {
  const stores = new Map<string, UserKnowledgeStore>();
  return {
    open: (identity) => {
      if (!stores.has(identity)) stores.set(identity, createMemoryUserKnowledgeStore());
      return stores.get(identity)!;
    },
  };
});

runUserKnowledgeStoreContract("local file", async () => {
  const home = await mkdtemp(join(tmpdir(), "pathrule-user-store-"));
  const env = { ...process.env, PATHRULE_HOME: home };
  return {
    open: (identity) => createFileUserKnowledgeStore(identity, env),
    dispose: () => rm(home, { recursive: true, force: true }),
  };
});

describe("the local file store", () => {
  it("writes the file the free functions read, and a hard delete removes the ledger copies too", async () => {
    const home = await mkdtemp(join(tmpdir(), "pathrule-user-store-"));
    const env = { ...process.env, PATHRULE_HOME: home };
    try {
      const store = createFileUserKnowledgeStore("local", env);
      await store.put(stampedUserKnowledgeFixture("a1"), {
        expectedVersion: null,
        operationId: "op-1",
        now: "2026-10-08T00:00:00.000Z",
      });
      expect((await readUserKnowledge("local", env)).map((a) => a.id)).toEqual(["a1"]);
      // Same format as before: schema 1, the atoms, nothing new inside the beliefs file.
      const file = JSON.parse(await readFile(userKnowledgePath("local", env), "utf8"));
      expect(Object.keys(file).sort()).toEqual([
        "atoms",
        "schema_version",
        "updated_at",
        "user_key",
      ]);
      expect(
        JSON.stringify(JSON.parse(await readFile(userKnowledgeLedgerPath("local", env), "utf8"))),
      ).toContain("a1");

      expect(
        await deleteUserKnowledge("local", "a1", { now: "2026-10-09T00:00:00.000Z", env }),
      ).toBe(true);
      expect(await store.get("a1")).toBeNull();
      expect((await store.history("a1")).items).toEqual([]);
      expect(await readFile(userKnowledgeLedgerPath("local", env), "utf8")).not.toContain("a1");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("concurrent writers in one process: exactly one wins a version, the other is told", async () => {
    const home = await mkdtemp(join(tmpdir(), "pathrule-user-store-"));
    const env = { ...process.env, PATHRULE_HOME: home };
    try {
      const store = createFileUserKnowledgeStore("local", env);
      const put = await store.put(stampedUserKnowledgeFixture("a1"), {
        expectedVersion: null,
        operationId: "op-0",
        now: "2026-10-08T00:00:00.000Z",
      });
      if (put.status !== "written") throw new Error("seed failed");
      const results = await Promise.all(
        ["medium", "low"].map((confidence, i) =>
          store.put(
            stampedUserKnowledgeFixture("a1", { confidence: confidence as "medium" | "low" }),
            {
              expectedVersion: put.record.version,
              operationId: `op-${i + 1}`,
              now: "2026-10-08T00:00:00.000Z",
            },
          ),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual(["conflict", "written"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
