// SPDX-License-Identifier: Apache-2.0
/**
 * The UserKnowledgeStore contract, as tests any implementation must pass: the local file, the
 * in-memory reference, and a managed account store's adapter. If two stores diverge, this fails.
 */
import { describe, expect, it } from "vitest";
import type { UserKnowledgeAtom } from "./user-knowledge.js";
import {
  findUserKnowledgeByFingerprint,
  listAllUserKnowledge,
  type UserKnowledgeStore,
} from "./user-knowledge-persistence.js";

const NOW = "2026-10-08T00:00:00.000Z";
const LATER = "2026-10-09T00:00:00.000Z";

/** A stamped atom, as a store holds one. */
export function stampedUserKnowledgeFixture(
  id: string,
  over: Partial<UserKnowledgeAtom> = {},
): UserKnowledgeAtom {
  return {
    id,
    kind: "user_knowledge",
    primitive: "selection",
    scope: "user",
    claim: `Prefer the approach named ${id}.`,
    claim_evidence: [`approach ${id}`],
    trigger_evidence: [],
    source_type: "EXPLICIT",
    evidence: [
      {
        kind: "teaching",
        quote: `use approach ${id}`,
        observed_at: NOW,
        surface: "cli",
        workspace_id: null,
        thread_id: null,
        message_id: `msg-${id}`,
        taught: true,
      },
    ],
    confidence: "high",
    status: "active",
    applies_to_workspace_id: null,
    applies_to_path: null,
    created_at: NOW,
    updated_at: NOW,
    last_observed_at: NOW,
    superseded_by: null,
    fingerprint: `fp-${id}`,
    ...over,
  };
}

/**
 * `open(identity)` returns the store one person's beliefs live in; every call to `fresh` starts an
 * empty world (a new home directory, a new reference instance).
 */
export function runUserKnowledgeStoreContract(
  label: string,
  fresh: () => Promise<{
    open: (identity: string) => UserKnowledgeStore;
    dispose?: () => Promise<void>;
  }>,
): void {
  const withWorld = async (
    run: (open: (identity: string) => UserKnowledgeStore) => Promise<void>,
  ) => {
    const world = await fresh();
    try {
      await run(world.open);
    } finally {
      await world.dispose?.();
    }
  };

  describe(`UserKnowledgeStore contract: ${label}`, () => {
    it("a put names the version it read; a stale or missing version is a conflict that writes nothing", async () =>
      withWorld(async (open) => {
        const store = open("person-a");
        const first = await store.put(stampedUserKnowledgeFixture("a1"), {
          expectedVersion: null,
          operationId: "op-1",
          now: NOW,
        });
        expect(first.status).toBe("written");
        if (first.status !== "written") return;
        expect((await store.get("a1"))?.version).toBe(first.record.version);

        // "Must not exist yet" when it exists: a conflict that reports what is stored.
        const again = await store.put(stampedUserKnowledgeFixture("a1", { claim: "Other." }), {
          expectedVersion: null,
          operationId: "op-2",
          now: NOW,
        });
        expect(again).toEqual({ status: "conflict", current: first.record });

        const stale = await store.put(stampedUserKnowledgeFixture("a1", { claim: "Stale." }), {
          expectedVersion: "not-a-version",
          operationId: "op-3",
          now: NOW,
        });
        expect(stale.status).toBe("conflict");
        expect((await store.get("a1"))?.atom.claim).toBe("Prefer the approach named a1.");

        const updated = await store.put(
          stampedUserKnowledgeFixture("a1", { confidence: "medium", updated_at: LATER }),
          { expectedVersion: first.record.version, operationId: "op-4", now: LATER },
        );
        expect(updated.status).toBe("written");
        if (updated.status !== "written") return;
        expect(updated.record.version).not.toBe(first.record.version);
        expect((await store.get("a1"))?.atom.confidence).toBe("medium");
      }));

    it("an operation id is applied once: a retry returns that result, and reuse for another change fails", async () =>
      withWorld(async (open) => {
        const store = open("person-a");
        const o = { expectedVersion: null, operationId: "op-once", now: NOW };
        const first = await store.put(stampedUserKnowledgeFixture("a1"), o);
        const retry = await store.put(stampedUserKnowledgeFixture("a1"), o);
        expect(first.status === "written" && first.replayed).toBe(false);
        expect(retry).toEqual(first.status === "written" ? { ...first, replayed: true } : first);
        expect((await store.history("a1")).items).toHaveLength(1);
        await expect(store.put(stampedUserKnowledgeFixture("b1"), o)).rejects.toThrow(
          "already used for a different change",
        );

        // A conflict consumes nothing: the same id goes through once the version is right.
        const conflicted = await store.put(stampedUserKnowledgeFixture("a1", { claim: "Next." }), {
          expectedVersion: "stale",
          operationId: "op-after",
          now: NOW,
        });
        expect(conflicted.status).toBe("conflict");
        const current = await store.get("a1");
        const applied = await store.put(stampedUserKnowledgeFixture("a1", { claim: "Next." }), {
          expectedVersion: current!.version,
          operationId: "op-after",
          now: NOW,
        });
        expect(applied.status === "written" && applied.replayed).toBe(false);
      }));

    it("refuses an atom that was not stamped", async () =>
      withWorld(async (open) => {
        const store = open("person-a");
        const o = { expectedVersion: null, operationId: "op", now: NOW };
        const unstamped = { ...stampedUserKnowledgeFixture("a1") } as Partial<UserKnowledgeAtom>;
        delete unstamped.fingerprint;
        await expect(store.put(unstamped as UserKnowledgeAtom, o)).rejects.toThrow("fingerprint");
        await expect(
          store.put(stampedUserKnowledgeFixture("a1", { status: "promoted" as never }), o),
        ).rejects.toThrow("status");
        expect(await store.get("a1")).toBeNull();
      }));

    it("lists every atom by id, one page at a time", async () =>
      withWorld(async (open) => {
        const store = open("person-a");
        for (const id of ["e", "b", "a", "d", "c"]) {
          await store.put(
            stampedUserKnowledgeFixture(id, { status: id === "c" ? "retired" : "active" }),
            {
              expectedVersion: null,
              operationId: `op-${id}`,
              now: NOW,
            },
          );
        }
        const pages: string[][] = [];
        let cursor: string | null = null;
        do {
          const page = await store.list({ cursor, limit: 2 });
          pages.push(page.items.map((r) => r.atom.id));
          cursor = page.next;
        } while (cursor !== null);
        expect(pages).toEqual([["a", "b"], ["c", "d"], ["e"]]);
        expect((await listAllUserKnowledge(store)).map((r) => r.atom.id)).toEqual([
          "a",
          "b",
          "c",
          "d",
          "e",
        ]);
        expect((await findUserKnowledgeByFingerprint(store, "fp-d"))?.atom.id).toBe("d");
      }));

    it("retires by supersession or outright, keeps the atom, and records both revisions", async () =>
      withWorld(async (open) => {
        const store = open("person-a");
        const put = await store.put(stampedUserKnowledgeFixture("old"), {
          expectedVersion: null,
          operationId: "op-put",
          now: NOW,
        });
        if (put.status !== "written") throw new Error("put failed");

        expect(
          (
            await store.retire("old", {
              expectedVersion: "stale",
              operationId: "op-r0",
              now: LATER,
            })
          ).status,
        ).toBe("conflict");
        const retired = await store.retire("old", {
          expectedVersion: put.record.version,
          replacementId: "new",
          operationId: "op-r1",
          now: LATER,
        });
        expect(retired.status).toBe("written");
        const kept = await store.get("old");
        expect(kept?.atom).toMatchObject({
          status: "retired",
          superseded_by: "new",
          updated_at: LATER,
        });

        const history = await store.history("old");
        expect(history.items.map((r) => [r.kind, r.operationId])).toEqual([
          ["retire", "op-r1"],
          ["put", "op-put"],
        ]);
        expect(history.items[0]!.previousVersion).toBe(put.record.version);
        const firstPage = await store.history("old", { limit: 1 });
        expect(firstPage.items.map((r) => r.kind)).toEqual(["retire"]);
        const secondPage = await store.history("old", { cursor: firstPage.next, limit: 1 });
        expect(secondPage.items.map((r) => r.kind)).toEqual(["put"]);
        expect(secondPage.next).toBeNull();

        const missing = await store.retire("nobody", {
          expectedVersion: "x",
          operationId: "op-r2",
          now: LATER,
        });
        expect(missing).toEqual({ status: "conflict", current: null });

        await store.put(stampedUserKnowledgeFixture("plain"), {
          expectedVersion: null,
          operationId: "op-plain",
          now: NOW,
        });
        const plain = await store.get("plain");
        await store.retire("plain", {
          expectedVersion: plain!.version,
          operationId: "op-r3",
          now: LATER,
        });
        expect((await store.get("plain"))?.atom).toMatchObject({
          status: "retired",
          superseded_by: null,
        });
      }));

    it("one person's store never shows another person's beliefs", async () =>
      withWorld(async (open) => {
        await open("person-a").put(stampedUserKnowledgeFixture("a1"), {
          expectedVersion: null,
          operationId: "op-a",
          now: NOW,
        });
        expect((await open("person-b").list()).items).toEqual([]);
        expect(await open("person-b").get("a1")).toBeNull();
        expect((await open("person-a").list()).items.map((r) => r.atom.id)).toEqual(["a1"]);
      }));
  });
}
