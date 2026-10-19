// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { captureGroundedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import { stampProposedRemedy } from "@pathrule/agent-ir/atoms/remedy-fingerprint.js";
import { RETIRED_BY } from "./grounded-store.js";

const NOW = "2026-10-15T00:00:00.000Z";
const BODY = "When the build fails with E42, run `pnpm clean`.";

async function setup() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => NOW });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  const node = await b.ensureNodeForPath("ws", "/apps/web", "folder");
  const memory = await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "E42", content: BODY });
  const captured = captureGroundedAtom({ kind: "remedy", condition: ["the build fails with E42"], action: ["run `pnpm clean`"] }, { kind: "memory", id: memory.id, title: memory.title, content: memory.content }, NOW);
  if (!captured.ok || captured.atom.kind !== "remedy") throw new Error("fixture");
  return { b, memory, atom: captured.atom };
}

const delivered = (b: LocalBackend) => b.advisoriesForHookIndex("ws").map((a) => a.ref);

describe("grounded atoms in the local store", () => {
  it("activate on capture, are idempotent, and reach the hook index", async () => {
    const { b, atom } = await setup();
    expect(await b.recordGroundedAtom("ws", atom)).toBe("activated");
    expect(await b.recordGroundedAtom("ws", atom)).toBe("already_active");
    expect(delivered(b)).toEqual([atom.id]);
  });

  it("never override a person's rejection, and never downgrade a person's approval", async () => {
    const { b, atom } = await setup();
    const proposal = await b.proposeRemedyAtom("ws", stampProposedRemedy(
      { variant: atom.variant, condition_evidence: atom.condition_evidence, condition_normalized: null, action_evidence: atom.action_evidence, evidence_state: atom.evidence_state, source: atom.source, observed_at: atom.observed_at },
      { now: NOW },
    ));
    await b.decideRemedyAtom("ws", proposal.id, "reject", "user-1");
    expect(await b.recordGroundedAtom("ws", atom)).toBe("kept_declined");
    expect(delivered(b)).toEqual([]);

    const fresh = await setup();
    await fresh.b.recordGroundedAtom("ws", fresh.atom);
    await fresh.b.decideRemedyAtom("ws", fresh.atom.id, "approve", "user-1");
    expect(await fresh.b.recordGroundedAtom("ws", fresh.atom)).toBe("kept_approved");
    expect(delivered(fresh.b)).toEqual([fresh.atom.id]);
  });

  it("activate an engine proposal of the same evidence instead of minting a second atom", async () => {
    const { b, atom } = await setup();
    await b.proposeRemedyAtom("ws", stampProposedRemedy(
      { variant: atom.variant, condition_evidence: atom.condition_evidence, condition_normalized: null, action_evidence: atom.action_evidence, evidence_state: atom.evidence_state, source: atom.source, observed_at: atom.observed_at },
      { now: NOW },
    ));
    expect(await b.recordGroundedAtom("ws", atom)).toBe("activated");
    expect(delivered(b)).toHaveLength(1);
  });

  it("go silent when the source stops saying them, and come back when it does again", async () => {
    const { b, memory, atom } = await setup();
    await b.recordGroundedAtom("ws", atom);
    await b.updateMemory({ id: memory.id, content: "E42 no longer happens." });
    expect(delivered(b)).toEqual([]);
    await b.updateMemory({ id: memory.id, content: BODY });
    expect(delivered(b)).toEqual([atom.id]);
  });
});

describe("retirement by outcome evidence", () => {
  const strongFailure = (b: LocalBackend, atomId: string, sessionId: string) =>
    b.recordKnowledgeEvidence({ workspaceId: "ws", atomId, deliveryId: `${sessionId}:${atomId}`, sessionId, path: null, eventType: "outcome_failure", evidenceKind: "error_persisted", strength: "STRONG", reason: "error_persisted" });

  it("retires a grounded atom that failed strongly in two sessions and never succeeded", async () => {
    const { b, atom } = await setup();
    await b.recordGroundedAtom("ws", atom);
    await strongFailure(b, atom.id, "s1");
    await b.ingestObservationsFromDisk("ws", "/nonexistent/knowledge-observations.jsonl");
    expect(delivered(b)).toEqual([atom.id]); // one session is not enough, and a missing file runs no pass
    await strongFailure(b, atom.id, "s2");
    const { retireFailedGroundedAtoms } = await import("./grounded-store.js");
    const db = (b as unknown as { db: Parameters<typeof retireFailedGroundedAtoms>[0] }).db;
    expect(retireFailedGroundedAtoms(db, "ws", NOW)).toEqual([atom.id]);
    expect(delivered(b)).toEqual([]);
    const row = db.prepare("SELECT status, approved_by FROM knowledge_atoms WHERE id = ?").get(atom.id) as { status: string; approved_by: string };
    expect(row).toEqual({ status: "rejected", approved_by: RETIRED_BY });
    // Retired is final for this evidence: a new capture does not bring it back.
    expect(await b.recordGroundedAtom("ws", atom)).toBe("kept_declined");
  });

  it("keeps an atom that also succeeded, and never retires a human-approved one", async () => {
    const { b, atom } = await setup();
    await b.recordGroundedAtom("ws", atom);
    await strongFailure(b, atom.id, "s1");
    await strongFailure(b, atom.id, "s2");
    await b.recordKnowledgeEvidence({ workspaceId: "ws", atomId: atom.id, deliveryId: `s3:${atom.id}`, sessionId: "s3", path: null, eventType: "outcome_success", evidenceKind: "check_pass", strength: "STRONG", reason: "check_pass" });
    const { retireFailedGroundedAtoms } = await import("./grounded-store.js");
    const db = (b as unknown as { db: Parameters<typeof retireFailedGroundedAtoms>[0] }).db;
    expect(retireFailedGroundedAtoms(db, "ws", NOW)).toEqual([]);

    const human = await setup();
    await human.b.recordGroundedAtom("ws", human.atom);
    await human.b.decideRemedyAtom("ws", human.atom.id, "approve", "user-1");
    await strongFailure(human.b, human.atom.id, "s1");
    await strongFailure(human.b, human.atom.id, "s2");
    const hdb = (human.b as unknown as { db: Parameters<typeof retireFailedGroundedAtoms>[0] }).db;
    expect(retireFailedGroundedAtoms(hdb, "ws", NOW)).toEqual([]);
  });
});
