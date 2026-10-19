// SPDX-License-Identifier: Apache-2.0
/**
 * V31 Agent IR: REMEDY + SELECTION + PROCEDURE compile into ONE bounded advisory IR. Proves
 * presentation precedence (remedy > selection > procedure), a shared budget, scope + lifecycle
 * eligibility, and deterministic conflict handling: CONSTRAINT dominates a preference/procedure, and
 * two contradictory preferences are withheld rather than one arbitrarily chosen.
 */
import { describe, it, expect } from "vitest";
import { compileKnowledgeIR, renderAgentKnowledgeIR, renderEntryLine, type AgentExecutionContext, type ScopedSelection, type ScopedProcedure, type ScopedRemedy } from "./agent-ir.js";
import { stampProposedSelection } from "../atoms/selection-fingerprint.js";
import { approveSelection, type SelectionInput } from "../atoms/selection.js";
import { stampProposedProcedure, approveProcedure, type ProcedureInput } from "../atoms/procedure.js";
import { approveRemedy, type RemedyInput } from "../atoms/remedy.js";
import { stampProposedRemedy } from "../atoms/remedy-fingerprint.js";

const ctx = (path: string | null): AgentExecutionContext => ({ workspace_id: "ws", path, compiled_at: "2026-09-10T00:00:00.000Z" });

let n = 0;
function sel(preferred: string[], scope: string | null, over: Partial<SelectionInput> = {}): ScopedSelection {
  const input: SelectionInput = { context_evidence: over.context_evidence ?? ["server calls"], context_normalized: null, preferred_evidence: preferred, alternative_evidence: over.alternative_evidence ?? [], strength: over.strength ?? "ESTABLISHED", source: { kind: "memory", id: `s${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveSelection(stampProposedSelection(input, { now: "t" }), "u"), scope };
}
function proc(steps: string[], scope: string | null): ScopedProcedure {
  // Distinct operation per procedure (from its first step) so unrelated procedures do not read as a
  // conflict under V33 (same-operation different-steps is a real conflict; these are different ops).
  const input: ProcedureInput = { operation_evidence: [], operation_normalized: `operation for ${steps[0]}`, steps, source: { kind: "memory", id: `p${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveProcedure(stampProposedProcedure(input, { now: "t" }), "u"), scope };
}
function rem(action: string[], scope: string | null): ScopedRemedy {
  const input: RemedyInput = { variant: "trouble", condition_evidence: ["it broke"], condition_normalized: null, action_evidence: action, evidence_state: "OBSERVED_SUCCESS", source: { kind: "memory", id: `r${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveRemedy(stampProposedRemedy(input, { now: "t" }), "u"), scope };
}

describe("compileKnowledgeIR: multi-primitive", () => {
  it("delivers a selection as a preference and a procedure as ordered steps", () => {
    const ir = compileKnowledgeIR({ selections: [sel(["ServerClient"], "/apps/web", { alternative_evidence: ["GeneratedClient"] })], procedures: [proc(["define schema", "implement handler"], "/apps/web")] }, ctx("/apps/web/x.ts"));
    const out = renderAgentKnowledgeIR(ir);
    expect(out).toContain("the preferred choice is ServerClient over GeneratedClient");
    expect(out).toContain("Procedure for");
    expect(out).toMatch(/1\. define schema/);
    expect(out).toMatch(/2\. implement handler/);
  });

  it("orders remedy before selection before procedure", () => {
    const ir = compileKnowledgeIR({ remedies: [rem(["safeFoo()"], "/apps/web")], selections: [sel(["ServerClient"], "/apps/web")], procedures: [proc(["a step here", "b step here"], "/apps/web")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.map((e) => e.type)).toEqual(["remedy", "selection", "procedure"]);
  });

  it("shares one bounded budget across all kinds", () => {
    const selections = Array.from({ length: 6 }, (_, i) => sel([`Choice${i}`], "/apps/web", { context_evidence: [`context ${i}`] }));
    const procedures = Array.from({ length: 6 }, (_, i) => proc([`step ${i} one`, `step ${i} two`], "/apps/web"));
    const ir = compileKnowledgeIR({ selections, procedures }, ctx("/apps/web/x.ts"), { budget: 8 });
    expect(ir.entries).toHaveLength(8);
    expect(ir.provenance.truncated).toBe(true);
  });

  it("proposed / out-of-scope selections and procedures are not delivered", () => {
    const proposed: ScopedSelection = { atom: stampProposedSelection({ context_evidence: ["x"], context_normalized: null, preferred_evidence: ["Foo"], alternative_evidence: [], strength: "ESTABLISHED", source: { kind: "memory", id: "sp", title: "t", node_path: null }, observed_at: "t" }, { now: "t" }), scope: "/apps/web" };
    const ir = compileKnowledgeIR({ selections: [proposed, sel(["Bar"], "/apps/api")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries).toHaveLength(0); // proposed not deliverable; /apps/api out of scope
  });

  it("CONSTRAINT > SELECTION: a preference for a forbidden literal is dropped", () => {
    const ir = compileKnowledgeIR({ selections: [sel(["axios"], "/apps/web"), sel(["ServerClient"], "/apps/web", { context_evidence: ["other context"] })], forbidden: ["axios"] }, ctx("/apps/web/x.ts"));
    const prefs = ir.entries.filter((e) => e.type === "selection");
    expect(prefs).toHaveLength(1);
    expect(renderAgentKnowledgeIR(ir)).not.toContain("axios");
  });

  it("CONSTRAINT > PROCEDURE: a procedure with a forbidden step is withheld whole", () => {
    const ir = compileKnowledgeIR({ procedures: [proc(["edit config file", "run deploy-prod script"], "/apps/web")], forbidden: ["deploy-prod"] }, ctx("/apps/web/x.ts"));
    expect(ir.entries).toHaveLength(0);
  });

  it("SELECTION vs SELECTION: same context, different preferred -> both withheld", () => {
    const ir = compileKnowledgeIR({ selections: [sel(["fetch"], "/apps/web", { context_evidence: ["http calls"] }), sel(["axios"], "/apps/web", { context_evidence: ["http calls"] })] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.filter((e) => e.type === "selection")).toHaveLength(0);
  });

  it("SELECTION never renders as a prohibition (states preference, not denial)", () => {
    const ir = compileKnowledgeIR({ selections: [sel(["ServerClient"], "/apps/web", { alternative_evidence: ["GeneratedClient"] })] }, ctx("/apps/web/x.ts"));
    // Check the SELECTION line itself (the fixed header legitimately says "never override a rule").
    const line = renderEntryLine(ir.entries.find((e) => e.type === "selection")!);
    expect(line).not.toMatch(/never|do not|must not|forbidden/i);
    expect(line).toContain("preferred choice");
  });
});
