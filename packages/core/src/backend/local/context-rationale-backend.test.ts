// SPDX-License-Identifier: Apache-2.0

import { loadLearningContext } from "../../project-learning/claim-service.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * V32 CONTEXT + RATIONALE end to end against a real SQLite LocalBackend: propose -> approve ->
 * scope-resolve -> project for the hook index. The generic knowledge_atoms table holds both new kinds
 * with no schema change; the temporal gate and scope isolation hold; enforcement never escalates.
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { stampProposedContext } from "@pathrule/agent-ir/atoms/context-fingerprint.js";
import type { ContextInput, ContextTemporalStatus } from "@pathrule/agent-ir/atoms/context.js";
import { stampProposedRationale, type RationaleInput } from "@pathrule/agent-ir/atoms/rationale.js";

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-14T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function memSource(b: LocalBackend, path: string, content: string) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content });
  return ((b as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
}
async function context(b: LocalBackend, path: string, fact: string, temporal_status: ContextTemporalStatus = "CURRENT") {
  const id = await memSource(b, path, fact);
  const input: ContextInput = { fact_evidence: [fact], fact_normalized: null, topic: null, temporal_status, source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return b.proposeContextAtom("ws", stampProposedContext(input, { now: "t" }));
}
async function rationale(b: LocalBackend, path: string, subject: string, reason: string) {
  const id = await memSource(b, path, `${subject} because ${reason}`);
  const input: RationaleInput = { subject_evidence: [], subject_normalized: subject, reason_evidence: [reason], source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return b.proposeRationaleAtom("ws", stampProposedRationale(input, { now: "t" }));
}

describe("V32 CONTEXT backend lifecycle + delivery", () => {
  it("reuses existing approved atoms as local learning hints without requiring a model", async () => {
    const b = make();
    try {
      const atom = await context(b, "/apps/web", "the api is generated from openapi");
      const load = (scope = "/apps/web") => loadLearningContext({ backend: b, workspaceId: "ws", localRootPath: process.cwd(), scope });
      expect((await load()).localHints).toBeUndefined();
      await b.decideContextAtom("ws", atom.id, "approve", "u");
      expect((await load()).localHints).toEqual([expect.objectContaining({ ref: atom.id, origin: "existing_approved_local_atom" })]);
      expect((await load("/apps/other")).localHints).toBeUndefined();
      expect(await b.listLearningClaims("ws")).toEqual([]);
      await b.decideContextAtom("ws", atom.id, "reject", "u");
      expect((await load()).localHints).toBeUndefined();
    } finally { b.close(); }
  });

  it("propose stores it; not delivered until approved; CURRENT delivers", async () => {
    const b = make();
    const atom = await context(b, "/apps/web", "the api is generated from openapi");
    expect(await b.listProposedContextAtoms("ws")).toHaveLength(1);
    expect(b.contextsForHookIndex("ws")).toHaveLength(0);
    await b.decideContextAtom("ws", atom.id, "approve", "u");
    const advs = b.contextsForHookIndex("ws");
    expect(advs).toHaveLength(1);
    expect(advs[0]!.scope).toBe("/apps/web");
    expect(advs[0]!.fact).toContain("generated from openapi");
  });
  it("a HISTORICAL fact is stored but never delivered even when approved", async () => {
    const b = make();
    const atom = await context(b, "/apps/web", "we rendered client-side in 2023", "HISTORICAL");
    await b.decideContextAtom("ws", atom.id, "approve", "u");
    expect(b.contextsForHookIndex("ws")).toHaveLength(0);
  });
  it("reject persists and never delivers", async () => {
    const b = make();
    const atom = await context(b, "/apps/web", "the gateway owns auth");
    await b.decideContextAtom("ws", atom.id, "reject", "u");
    expect(b.contextsForHookIndex("ws")).toHaveLength(0);
    expect(await b.listProposedContextAtoms("ws")).toHaveLength(0);
  });
});

describe("V32 RATIONALE backend lifecycle + delivery", () => {
  it("propose -> approve delivers the reason with its subject", async () => {
    const b = make();
    const atom = await rationale(b, "/apps/web", "use ServerClient", "GeneratedClient breaks streaming");
    expect(b.rationalesForHookIndex("ws")).toHaveLength(0);
    await b.decideRationaleAtom("ws", atom.id, "approve", "u");
    const advs = b.rationalesForHookIndex("ws");
    expect(advs).toHaveLength(1);
    expect(advs[0]!.reason).toContain("GeneratedClient breaks streaming");
    expect(advs[0]!.scope).toBe("/apps/web");
  });
  it("both kinds coexist in the generic table without collision", async () => {
    const b = make();
    const c = await context(b, "/apps/web", "the api is generated");
    const r = await rationale(b, "/apps/web", "the api is generated", "the schema is the source of truth");
    await b.decideContextAtom("ws", c.id, "approve", "u");
    await b.decideRationaleAtom("ws", r.id, "approve", "u");
    expect(b.contextsForHookIndex("ws")).toHaveLength(1);
    expect(b.rationalesForHookIndex("ws")).toHaveLength(1);
  });
});
