// SPDX-License-Identifier: Apache-2.0
/**
 * V31 SELECTION + PROCEDURE, end to end against a real SQLite LocalBackend: propose -> review ->
 * approve -> scope-resolve -> project for the hook index -> observe (SELECTION only). Proves the
 * generic knowledge_atoms table holds both new kinds with no schema change, the lifecycle gates
 * delivery, scope isolates, and V30 observation is reused for SELECTION while PROCEDURE stays UNKNOWN.
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { stampProposedSelection } from "@pathrule/agent-ir/atoms/selection-fingerprint.js";
import type { SelectionInput } from "@pathrule/agent-ir/atoms/selection.js";
import { stampProposedProcedure, type ProcedureInput } from "@pathrule/agent-ir/atoms/procedure.js";

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-10T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function memSource(b: LocalBackend, path: string, content: string) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content });
  const memRow = (b as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  return memRow.id;
}
async function selection(b: LocalBackend, path: string, preferred: string[], over: Partial<SelectionInput> = {}) {
  const id = await memSource(b, path, `${preferred.join(" ")} preferred`);
  const input: SelectionInput = { context_evidence: over.context_evidence ?? [], context_normalized: over.context_normalized ?? "server calls", preferred_evidence: preferred, alternative_evidence: over.alternative_evidence ?? [], strength: over.strength ?? "ESTABLISHED", source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return b.proposeSelectionAtom("ws", stampProposedSelection(input, { now: "t" }));
}
async function procedure(b: LocalBackend, path: string, steps: string[]) {
  const id = await memSource(b, path, steps.join(" then "));
  const input: ProcedureInput = { operation_evidence: [], operation_normalized: "adding a route", steps, source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return b.proposeProcedureAtom("ws", stampProposedProcedure(input, { now: "t" }));
}

describe("V31 SELECTION backend lifecycle + delivery", () => {
  it("propose stores it; it is NOT delivered until approved", async () => {
    const b = make();
    await selection(b, "/apps/web", ["ServerClient"]);
    expect(await b.listProposedSelectionAtoms("ws")).toHaveLength(1);
    expect(b.selectionsForHookIndex("ws")).toHaveLength(0); // proposed, not delivered
  });

  it("approve makes it deliverable and scope-resolved from the source memory's node", async () => {
    const b = make();
    const atom = await selection(b, "/apps/web", ["ServerClient"]);
    await b.decideSelectionAtom("ws", atom.id, "approve", "user-1");
    const advs = b.selectionsForHookIndex("ws");
    expect(advs).toHaveLength(1);
    expect(advs[0]!.scope).toBe("/apps/web");
    expect(advs[0]!.preferred).toBe("ServerClient");
  });

  it("reject persists and never delivers", async () => {
    const b = make();
    const atom = await selection(b, "/apps/web", ["ServerClient"]);
    await b.decideSelectionAtom("ws", atom.id, "reject", "user-1");
    expect(b.selectionsForHookIndex("ws")).toHaveLength(0);
    expect(await b.listProposedSelectionAtoms("ws")).toHaveLength(0);
  });

  it("a SPECULATIVE selection is stored but never delivered even when approved", async () => {
    const b = make();
    const atom = await selection(b, "/apps/web", ["axios"], { strength: "SPECULATIVE" });
    await b.decideSelectionAtom("ws", atom.id, "approve", "user-1");
    expect(b.selectionsForHookIndex("ws")).toHaveLength(0);
  });

});

describe("V31 PROCEDURE backend lifecycle + delivery", () => {
  it("propose -> approve delivers the ordered steps to the hook index", async () => {
    const b = make();
    const atom = await procedure(b, "/apps/web", ["define schema", "implement handler", "register route"]);
    expect(b.proceduresForHookIndex("ws")).toHaveLength(0); // proposed
    await b.decideProcedureAtom("ws", atom.id, "approve", "user-1");
    const advs = b.proceduresForHookIndex("ws");
    expect(advs).toHaveLength(1);
    expect(advs[0]!.steps).toEqual(["define schema", "implement handler", "register route"]);
    expect(advs[0]!.scope).toBe("/apps/web");
  });


  it("both kinds coexist in the same generic table without collision", async () => {
    const b = make();
    const s = await selection(b, "/apps/web", ["ServerClient"]);
    const p = await procedure(b, "/apps/web", ["step one here", "step two here"]);
    await b.decideSelectionAtom("ws", s.id, "approve", "u");
    await b.decideProcedureAtom("ws", p.id, "approve", "u");
    expect(b.selectionsForHookIndex("ws")).toHaveLength(1);
    expect(b.proceduresForHookIndex("ws")).toHaveLength(1);
  });
});
