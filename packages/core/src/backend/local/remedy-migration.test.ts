// SPDX-License-Identifier: Apache-2.0
/**
 * Migration V6 against a REAL existing database, and against a fresh one.
 *
 * The contract suite already proves the behaviour on `:memory:`. What it cannot prove is the
 * thing that actually breaks in the field: a database that already holds a user's knowledge,
 * sitting at an older `user_version`, being opened by code that expects a table it has never
 * had. The workspace database on this machine is at version 4 with 301 memories, so it has to
 * cross V5 and V6 in one open.
 *
 * The file skips rather than fails when that database is absent, because a contributor's
 * checkout has no reason to contain one.
 */
import { existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RemedyInput } from "@pathrule/agent-ir/atoms/remedy.js";
import { stampProposedRemedy } from "@pathrule/agent-ir/atoms/remedy-fingerprint.js";

import { LocalBackend } from "./local-backend.js";

const WS = "467b0e6e-dec5-46a6-bd5e-4294a82603d6";
const REAL_DB = join(process.env["HOME"] ?? "", ".pathrule", WS, "pathrule.db");
const tmp = mkdtempSync(join(tmpdir(), "pathrule-remedy-migration-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function fixture(): ReturnType<typeof stampProposedRemedy> {
  const input: RemedyInput = {
    variant: "trouble",
    condition_evidence: ["The icon renders blank after the OS theme flips"],
    condition_normalized: null,
    action_evidence: ["re-registering the template image on the nativeTheme updated event"],
    evidence_state: "OBSERVED_SUCCESS",
    source: { kind: "memory", id: "mem-fixture", title: "Tray icon goes blank after a theme switch", node_path: "/packages/app" },
    observed_at: "2026-09-01T00:00:00.000Z",
  };
  // Stamped directly: the migration is under test, not the (proprietary) extraction validator.
  return stampProposedRemedy(input, { now: "2026-09-08T00:00:00.000Z" });
}

describe("migration V6 on a fresh database", () => {
  it("creates the table and round-trips an atom across a reopen", async () => {
    const path = join(tmp, "fresh.db");
    const atom = fixture();

    const first = new LocalBackend(path);
    await first.proposeRemedyAtom(WS, atom);
    expect(await first.listProposedRemedyAtoms(WS)).toHaveLength(1);
    first.close?.();

    // The reload is the point: a new process, a new connection, the same knowledge.
    const second = new LocalBackend(path);
    const pending = await second.listProposedRemedyAtoms(WS);
    expect(pending).toHaveLength(1);
    const back = pending[0]!;
    expect(back.id).toBe(atom.id);
    expect(back.fingerprint).toBe(atom.fingerprint);
    expect(back.condition_evidence).toEqual(atom.condition_evidence);
    expect(back.action_evidence).toEqual(atom.action_evidence);
    expect(back.evidence_state).toBe("OBSERVED_SUCCESS");
    expect(back.source).toEqual(atom.source);
    expect(back.observed_at).toBe(atom.observed_at);
    expect(back.status).toBe("proposed");
    expect(back.authority).toBe("inferred");
    second.close?.();
  });

  it("persists a decision across a reopen", async () => {
    const path = join(tmp, "decision.db");
    const atom = fixture();

    const first = new LocalBackend(path);
    await first.proposeRemedyAtom(WS, atom);
    await first.decideRemedyAtom(WS, atom.id, "approve", "sertan");
    first.close?.();

    const second = new LocalBackend(path);
    expect(await second.listProposedRemedyAtoms(WS)).toHaveLength(0);
    const all = await second.listRemedyAtomsForSubject("memory", "mem-fixture");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "active", authority: "human", approved_by: "sertan" });
    second.close?.();
  });

  it("a rejection survives a reopen and blocks the same evidence from returning", async () => {
    const path = join(tmp, "rejected.db");
    const atom = fixture();

    const first = new LocalBackend(path);
    await first.proposeRemedyAtom(WS, atom);
    await first.decideRemedyAtom(WS, atom.id, "reject", "sertan");
    first.close?.();

    const second = new LocalBackend(path);
    // Re-analysis of the same source produces the same fingerprint, so nothing returns.
    await second.proposeRemedyAtom(WS, fixture());
    expect(await second.listProposedRemedyAtoms(WS)).toHaveLength(0);
    expect(await second.listRemedyAtomsForSubject("memory", "mem-fixture")).toHaveLength(1);
    second.close?.();
  });
});

describe.skipIf(!existsSync(REAL_DB))("migration V6 on the real existing database", () => {
  it("crosses V5 and V6 without disturbing existing knowledge", async () => {
    const path = join(tmp, "existing.db");
    copyFileSync(REAL_DB, path);

    const backend = new LocalBackend(path);
    // The rows that were already there must still be there. This is the whole point of running
    // against a real database rather than a synthetic one.
    const memories = await backend.listMemories({ workspaceId: WS });
    expect(memories.length).toBeGreaterThan(100);

    const atom = fixture();
    await backend.proposeRemedyAtom(WS, atom);
    expect(await backend.listProposedRemedyAtoms(WS)).toHaveLength(1);
    backend.close?.();

    const reopened = new LocalBackend(path);
    const pending = await reopened.listProposedRemedyAtoms(WS);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action_evidence).toEqual(atom.action_evidence);
    // And the pre-existing knowledge is still intact after the write.
    expect((await reopened.listMemories({ workspaceId: WS })).length).toBe(memories.length);
    reopened.close?.();
  });
});
