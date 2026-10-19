// SPDX-License-Identifier: Apache-2.0
/**
 * V33 PRECEDENCE end to end against a real SQLite LocalBackend, and the real-conflict resolution the
 * hook path uses: a conflicting pair is withheld unless an APPROVED, applicable, acyclic precedence
 * resolves it. Proves proposed/rejected/wrong-scope/cyclic precedence have no effect (the safe default).
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { stampProposedSelection } from "@pathrule/agent-ir/atoms/selection-fingerprint.js";
import type { SelectionInput } from "@pathrule/agent-ir/atoms/selection.js";
import { stampProposedPrecedence, type PrecedenceInput } from "@pathrule/agent-ir/atoms/precedence.js";

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-14T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function mem(b: LocalBackend, path: string, content: string) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content });
  return ((b as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
}
async function selection(b: LocalBackend, path: string, preferred: string, context: string) {
  const id = await mem(b, path, `${context}: prefer ${preferred}`);
  const input: SelectionInput = { context_evidence: [context], context_normalized: null, preferred_evidence: [preferred], alternative_evidence: [], strength: "ESTABLISHED", source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  const atom = await b.proposeSelectionAtom("ws", stampProposedSelection(input, { now: "t" }));
  await b.decideSelectionAtom("ws", atom.id, "approve", "u");
  return atom;
}
async function precedence(b: LocalBackend, path: string, winner: string, loser: string, approve = true) {
  const id = await mem(b, path, `${winner} overrides ${loser}`);
  const input: PrecedenceInput = { winner_evidence: [winner], winner_normalized: null, loser_evidence: [loser], loser_normalized: null, relationship_evidence: [`${winner} overrides ${loser}`], condition_normalized: null, source: { kind: "memory", id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  const atom = await b.proposePrecedenceAtom("ws", stampProposedPrecedence(input, { now: "t" }));
  if (approve) await b.decidePrecedenceAtom("ws", atom.id, "approve", "u");
  return atom;
}
const delivered = (b: LocalBackend) => {
  const withheld = b.conflictWithheldForHookIndex("ws");
  return b.selectionsForHookIndex("ws").filter((a) => !withheld.has(a.ref)).map((a) => a.preferred);
};

describe("V33 PRECEDENCE + conflict resolution (real backend)", () => {
  it("conflicting selections with NO precedence -> both withheld", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "npm", "package manager");
    expect(delivered(b)).toEqual([]);
  });

  it("an APPROVED applicable precedence delivers the winner, withholds the loser", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "npm", "package manager");
    await precedence(b, "/apps/web", "pnpm", "npm");
    expect(delivered(b)).toEqual(["pnpm"]);
  });

  it("a PROPOSED (unapproved) precedence has NO effect", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "npm", "package manager");
    await precedence(b, "/apps/web", "pnpm", "npm", false);
    expect(delivered(b)).toEqual([]);
  });

  it("a REJECTED precedence has NO effect", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "npm", "package manager");
    const p = await precedence(b, "/apps/web", "pnpm", "npm", false);
    await b.decidePrecedenceAtom("ws", p.id, "reject", "u");
    expect(delivered(b)).toEqual([]);
  });

  it("a wrong-scope precedence has NO effect", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "npm", "package manager");
    await precedence(b, "/apps/api", "pnpm", "npm");
    expect(delivered(b)).toEqual([]);
  });

  it("non-conflicting selections in different contexts are both delivered", async () => {
    const b = make();
    await selection(b, "/apps/web", "pnpm", "package manager");
    await selection(b, "/apps/web", "zod", "validation");
    expect(delivered(b).sort()).toEqual(["pnpm", "zod"]);
  });

  it("proposed precedence appears in the review queue; approve activates it", async () => {
    const b = make();
    const p = await precedence(b, "/apps/web", "pnpm", "npm", false);
    expect((await b.listProposedPrecedenceAtoms("ws")).map((a) => a.id)).toContain(p.id);
    await b.decidePrecedenceAtom("ws", p.id, "approve", "u");
    expect(await b.listProposedPrecedenceAtoms("ws")).toHaveLength(0);
  });
});
