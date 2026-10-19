// SPDX-License-Identifier: Apache-2.0
/**
 * V32 Agent IR: CONTEXT is delivered as compact facts, RATIONALE is attached to the atom it explains
 * (compaction) or withheld/last if standalone, and neither displaces higher-value operational
 * knowledge. Ordering, shared budget, temporal delivery gate, and enforcement isolation are asserted.
 */
import { describe, it, expect } from "vitest";
import {
  compileKnowledgeIR, renderAgentKnowledgeIR, renderEntryLine,
  type AgentExecutionContext, type ScopedContext, type ScopedRationale, type ScopedSelection, type ScopedRemedy,
} from "./agent-ir.js";
import { stampProposedContext } from "../atoms/context-fingerprint.js";
import { approveContext, type ContextInput, type ContextTemporalStatus } from "../atoms/context.js";
import { stampProposedRationale, approveRationale, type RationaleInput } from "../atoms/rationale.js";
import { stampProposedSelection } from "../atoms/selection-fingerprint.js";
import { approveSelection, type SelectionInput } from "../atoms/selection.js";
import { approveRemedy, type RemedyInput } from "../atoms/remedy.js";
import { stampProposedRemedy } from "../atoms/remedy-fingerprint.js";

const ctx = (path: string | null): AgentExecutionContext => ({ workspace_id: "ws", path, compiled_at: "2026-09-14T00:00:00.000Z" });
let n = 0;
function fact(f: string, scope: string | null, temporal_status: ContextTemporalStatus = "CURRENT"): ScopedContext {
  const input: ContextInput = { fact_evidence: [f], fact_normalized: null, topic: null, temporal_status, source: { kind: "memory", id: `c${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveContext(stampProposedContext(input, { now: "t" }), "u"), scope };
}
function why(subject: string, reason: string, scope: string | null): ScopedRationale {
  const input: RationaleInput = { subject_evidence: [], subject_normalized: subject, reason_evidence: [reason], source: { kind: "memory", id: `r${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveRationale(stampProposedRationale(input, { now: "t" }), "u"), scope };
}
function sel(preferred: string, scope: string | null): ScopedSelection {
  const input: SelectionInput = { context_evidence: [], context_normalized: "calls", preferred_evidence: [preferred], alternative_evidence: [], strength: "ESTABLISHED", source: { kind: "memory", id: `s${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveSelection(stampProposedSelection(input, { now: "t" }), "u"), scope };
}
function rem(action: string, scope: string | null): ScopedRemedy {
  const input: RemedyInput = { variant: "trouble", condition_evidence: ["it broke"], condition_normalized: null, action_evidence: [action], evidence_state: "OBSERVED_SUCCESS", source: { kind: "memory", id: `m${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveRemedy(stampProposedRemedy(input, { now: "t" }), "u"), scope };
}

describe("V32 CONTEXT + RATIONALE in Agent IR", () => {
  it("delivers a CURRENT context as a compact fact line", () => {
    const ir = compileKnowledgeIR({ contexts: [fact("the dashboard is server-side rendered", "/apps/web")] }, ctx("/apps/web/x.ts"));
    expect(renderAgentKnowledgeIR(ir)).toContain("Fact: the dashboard is server-side rendered");
  });

  it("does NOT deliver a HISTORICAL or SPECULATIVE context even when approved", () => {
    const ir = compileKnowledgeIR({ contexts: [fact("we rendered client-side", "/apps/web", "HISTORICAL"), fact("it might be faster", "/apps/web", "SPECULATIVE")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries).toHaveLength(0);
  });

  it("ATTACHES a rationale to the selection it explains (inline Reason, no separate slot)", () => {
    const ir = compileKnowledgeIR({
      selections: [sel("ServerClient", "/apps/web")],
      rationales: [why("ServerClient", "GeneratedClient cannot preserve streaming", "/apps/web")],
    }, ctx("/apps/web/x.ts"));
    expect(ir.entries).toHaveLength(1); // rationale folded into the selection, not a second entry
    const line = renderEntryLine(ir.entries[0]!);
    expect(line).toContain("preferred choice is ServerClient");
    expect(line).toContain("Reason: GeneratedClient cannot preserve streaming");
  });

  it("delivers an UNMATCHED rationale standalone, at the lowest priority", () => {
    const ir = compileKnowledgeIR({
      remedies: [rem("safeFoo()", "/apps/web")],
      rationales: [why("some unrelated decision", "a reason nobody references", "/apps/web")],
    }, ctx("/apps/web/x.ts"));
    expect(ir.entries.map((e) => e.type)).toEqual(["remedy", "rationale"]); // rationale last
  });

  it("orders remedy > selection > procedure > context > rationale", () => {
    const ir = compileKnowledgeIR({
      remedies: [rem("fixIt()", "/apps/web")],
      selections: [sel("ServerClient", "/apps/web")],
      contexts: [fact("the api is generated from openapi", "/apps/web")],
      rationales: [why("orphan", "because reasons", "/apps/web")],
    }, ctx("/apps/web/x.ts"));
    expect(ir.entries.map((e) => e.type)).toEqual(["remedy", "selection", "context", "rationale"]);
  });

  it("CONTEXT BUDGET: 50 in-scope facts do not crowd out a relevant remedy, and delivery stays bounded", () => {
    const contexts = Array.from({ length: 50 }, (_, i) => fact(`fact number ${i} about the system`, "/apps/web"));
    const ir = compileKnowledgeIR({ remedies: [rem("criticalFix()", "/apps/web")], contexts }, ctx("/apps/web/x.ts"), { budget: 8 });
    expect(ir.entries).toHaveLength(8);
    expect(ir.entries[0]!.type).toBe("remedy"); // operational knowledge kept first
    expect(ir.provenance.truncated).toBe(true);
  });

  it("CONTEXT budget STRESS: 1000 in-scope facts still compile to a bounded subset, quickly", () => {
    const contexts = Array.from({ length: 1000 }, (_, i) => fact(`system fact ${i} describing a subsystem`, "/apps/web"));
    const t0 = performance.now();
    const ir = compileKnowledgeIR({ contexts }, ctx("/apps/web/x.ts"), { budget: 8 });
    const dt = performance.now() - t0;
    expect(ir.entries).toHaveLength(8);
    expect(ir.provenance.eligible).toBe(1000);
    expect(ir.provenance.truncated).toBe(true);
    expect(dt).toBeLessThan(200); // deterministic filter+sort+slice, no model, no unbounded work
  });

  it("CONTEXT scope isolation: a /apps/web fact does not reach /apps/api", () => {
    const ir = compileKnowledgeIR({ contexts: [fact("web-only fact", "/apps/web")] }, ctx("/apps/api/x.ts"));
    expect(ir.entries).toHaveLength(0);
  });

  it("ENFORCEMENT ISOLATION: context + rationale entries carry the 'context' authority band, never higher", () => {
    const ir = compileKnowledgeIR({ contexts: [fact("a fact", "/apps/web")], rationales: [why("x", "because y", "/apps/web")] }, ctx("/apps/web/x.ts"));
    for (const e of ir.entries) expect(e.authority).toBe("context");
  });
});
