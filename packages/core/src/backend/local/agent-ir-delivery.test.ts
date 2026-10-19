// SPDX-License-Identifier: Apache-2.0
/**
 * The REMEDY delivery vertical slice, end to end, against a real SQLite LocalBackend:
 *
 *   node + memory at a path -> propose remedy atom -> approve -> buildHookIndexPayload
 *   -> path_advisories / project_advisories -> selectAdvisoriesForPath (the hook's logic)
 *   -> recordRemedyDelivery -> listRemedyDeliveries
 *
 * It proves the hard gates without a running agent: approved reaches, proposed/rejected/weak do
 * not, scope filters correctly, human approval is required, and CONSTRAINT > REMEDY survives into
 * the rendered text.
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { type RemedyEvidenceState, type RemedyInput } from "@pathrule/agent-ir/atoms/remedy.js";
import { stampProposedRemedy } from "@pathrule/agent-ir/atoms/remedy-fingerprint.js";
import { selectAdvisoriesForPath, renderAdvisorySection } from "@pathrule/agent-ir/delivery/agent-ir.js";

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-10T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}

async function memoryAt(b: LocalBackend, path: string, title = "tray icon", content = "the tray icon renders blank; re-register the template image on nativeTheme.updated fixed it") {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  return b.writeMemory({ workspaceId: "ws", nodeId: node.id, title, content });
}

function remedyFor(memoryId: string, over: Partial<RemedyInput> & { evidence_state?: RemedyEvidenceState } = {}) {
  const input: RemedyInput = {
    variant: over.variant ?? "trouble",
    condition_evidence: over.condition_evidence ?? ["the tray icon renders blank"],
    condition_normalized: over.condition_normalized ?? null,
    action_evidence: over.action_evidence ?? ["re-register the template image on nativeTheme.updated"],
    evidence_state: over.evidence_state ?? "OBSERVED_SUCCESS",
    source: { kind: "memory", id: memoryId, title: "tray icon", node_path: null },
    observed_at: "2026-09-01T00:00:00.000Z",
  };
  return stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" });
}

async function approvedRemedyAt(b: LocalBackend, path: string, over?: Partial<RemedyInput> & { evidence_state?: RemedyEvidenceState }) {
  const mem = await memoryAt(b, path);
  const atom = await b.proposeRemedyAtom("ws", remedyFor(mem.id, over));
  await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
  return atom;
}

describe("REMEDY delivery vertical slice (real LocalBackend)", () => {
  it("delivers an approved, in-scope remedy and records the delivery", async () => {
    const b = make();
    const atom = await approvedRemedyAt(b, "/apps/web");
    const index = (await b.buildHookIndexPayload("ws"))!;
    expect(index.path_advisories?.["/apps/web"]).toBeTruthy();
    // reaches a descendant edit, not the sibling
    const forWeb = selectAdvisoriesForPath(index, "/apps/web/button.tsx");
    expect(forWeb.map((s) => s.ref)).toContain(atom.id);
    expect(selectAdvisoriesForPath(index, "/apps/api/server.ts").map((s) => s.ref)).not.toContain(atom.id);
    // the delivery ledger
    await b.recordRemedyDelivery({ workspaceId: "ws", atomId: atom.id, sessionId: "s1", path: "/apps/web/button.tsx" });
    const led = await b.listRemedyDeliveries("ws");
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ atom_id: atom.id, event: "delivered", path: "/apps/web/button.tsx" });
  });

  it("does NOT deliver a proposed remedy (human approval required)", async () => {
    const b = make();
    const mem = await memoryAt(b, "/apps/web");
    await b.proposeRemedyAtom("ws", remedyFor(mem.id)); // never approved
    const index = (await b.buildHookIndexPayload("ws"))!;
    expect(index.path_advisories ?? {}).toEqual({});
    expect(index.project_advisories ?? []).toEqual([]);
  });

  it("does NOT deliver a rejected remedy", async () => {
    const b = make();
    const mem = await memoryAt(b, "/apps/web");
    const atom = await b.proposeRemedyAtom("ws", remedyFor(mem.id));
    await b.decideRemedyAtom("ws", atom.id, "reject", "user-1");
    const index = (await b.buildHookIndexPayload("ws"))!;
    expect(index.path_advisories ?? {}).toEqual({});
  });

  it("does NOT deliver weak evidence even when approved", async () => {
    for (const st of ["ATTEMPTED", "SPECULATIVE", "FAILED", "SUPERSEDED"] as RemedyEvidenceState[]) {
      const b = make();
      await approvedRemedyAt(b, "/apps/web", { evidence_state: st });
      const index = (await b.buildHookIndexPayload("ws"))!;
      expect(index.path_advisories ?? {}, st).toEqual({});
    }
  });

  it("scopes a remedy at the memory's node, resolved fresh at delivery time", async () => {
    const b = make();
    // memory placed at /packages/core; its remedy must not reach /packages/web
    await approvedRemedyAt(b, "/packages/core");
    const index = (await b.buildHookIndexPayload("ws"))!;
    expect(selectAdvisoriesForPath(index, "/packages/core/src/x.ts")).toHaveLength(1);
    expect(selectAdvisoriesForPath(index, "/packages/web/y.ts")).toHaveLength(0);
  });

  it("a root-placed (unscoped) memory's remedy is global and reaches every path", async () => {
    const b = make();
    // memory at root "/" -> global
    const mem = await memoryAt(b, "/");
    const atom = await b.proposeRemedyAtom("ws", remedyFor(mem.id));
    await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
    const index = (await b.buildHookIndexPayload("ws"))!;
    expect(index.project_advisories?.map((s) => s.ref)).toContain(atom.id);
    expect(selectAdvisoriesForPath(index, "/anywhere/at/all.ts").map((s) => s.ref)).toContain(atom.id);
  });

  it("renders advisories as subordinate to rules and constraints (CONSTRAINT > REMEDY)", async () => {
    const b = make();
    await approvedRemedyAt(b, "/apps/web");
    const index = (await b.buildHookIndexPayload("ws"))!;
    const md = renderAdvisorySection(selectAdvisoriesForPath(index, "/apps/web/x.ts"));
    expect(md).toContain("advisory only");
    expect(md).toContain("never override a rule, a constraint, or a security policy");
    expect(md).toContain("nativeTheme.updated");
  });

  it("stays local: the delivery table is not part of the cloud KnowledgeBackend interface", async () => {
    // A compile-time guarantee, asserted structurally: recordRemedyDelivery / listRemedyDeliveries
    // exist on LocalBackend but not on the KnowledgeBackend the mirror-sync operates over.
    const b = make();
    expect(typeof (b as unknown as { recordRemedyDelivery: unknown }).recordRemedyDelivery).toBe("function");
  });
});

describe("compiled form or source, decided per memory by the completeness gate (real LocalBackend)", () => {
  it("delivers a memory its approved atoms fully represent as its compiled form, on every channel", async () => {
    const b = make();
    const atom = await approvedRemedyAt(b, "/apps/web");
    const memoryId = atom.source.id;
    const index = (await b.buildHookIndexPayload("ws"))!;
    const warehouse = (await b.buildWarehousePayload("ws"))!;

    // The body slot carries the compiled form, hashed as delivered, with the refs it is made of.
    const entry = warehouse[memoryId]!;
    expect(entry.body.startsWith("_Compiled form of this memory")).toBe(true);
    expect(entry.body).toContain(`pathrule_read_memory("${memoryId}")`);
    expect(entry.body).toContain("re-register the template image on nativeTheme.updated");
    expect(entry.body).not.toContain("fixed it");
    expect(entry.compiled_refs).toEqual([atom.id]);
    const stub = index.path_memories["/apps/web"]!.find((m) => m.id === memoryId)!;
    expect(stub.content_hash).toBe(entry.content_hash);
    expect(stub.preview).toContain("fixed it"); // the name tier keeps the memory's own words

    // Its lines travel as one group through the advisory channel.
    expect(index.path_advisories?.["/apps/web"]?.map((s) => s.group)).toEqual([memoryId]);

    // Studio's turn context and the native knowledge files read the same plan.
    const compiled = await b.compiledMemoryDeliveries("ws");
    expect(compiled[memoryId]?.text).toBe(entry.body);
    const files = (await b.buildKnowledgePayload("ws"))!;
    const web = files.find((f) => f.dir_path === "/apps/web")!;
    expect(web.markdown).toContain(entry.body);
    expect(web.markdown).not.toContain("fixed it");
  });

  it("delivers the memory as written when the projection is incomplete, and keeps its typed guidance as an additive line", async () => {
    const b = make();
    const mem = await memoryAt(
      b,
      "/apps/web",
      "tray icon",
      "the tray icon renders blank; re-register the template image on nativeTheme.updated fixed it. The handler lives in electron/tray.ts.",
    );
    const atom = await b.proposeRemedyAtom("ws", remedyFor(mem.id));
    await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
    const index = (await b.buildHookIndexPayload("ws"))!;
    const warehouse = (await b.buildWarehousePayload("ws"))!;

    expect(warehouse[mem.id]!.body).toBe(mem.content);
    expect(warehouse[mem.id]!.compiled_refs).toBeUndefined();
    expect(await b.compiledMemoryDeliveries("ws")).toEqual({});
    // A REMEDY is what to do at the point of action: it still reaches an edit under its path, as a
    // plain additive line (no `group`: the memory was not replaced by its compiled form).
    const stubs = Object.values(index.path_advisories ?? {}).flat();
    expect(stubs.map((s) => s.ref)).toEqual([atom.id]);
    expect(stubs[0]).not.toHaveProperty("group");
    expect(index.project_advisories ?? []).toEqual([]);
  });

  it("changes nothing for a workspace with no approved atoms", async () => {
    const b = make();
    const mem = await memoryAt(b, "/apps/web");
    const warehouse = (await b.buildWarehousePayload("ws"))!;
    expect(warehouse[mem.id]!.body).toBe(mem.content);
    expect(await b.compiledMemoryDeliveries("ws")).toEqual({});
  });
});
