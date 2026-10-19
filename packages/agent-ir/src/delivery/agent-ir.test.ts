// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  compileAgentKnowledgeIR,
  projectRemedyToAdvisory,
  renderAgentKnowledgeIR,
  renderAdvisorySection,
  scopeApplies,
  selectAdvisoriesForPath,
  type AgentExecutionContext,
  type ScopedRemedy,
} from "./agent-ir.js";
import { approveRemedy, rejectRemedy, type RemedyAtom, type RemedyEvidenceState, type RemedyInput } from "../atoms/remedy.js";
import { stampProposedRemedy } from "../atoms/remedy-fingerprint.js";

function atom(over: Partial<RemedyInput> & { evidence_state?: RemedyEvidenceState } = {}): RemedyAtom {
  const input: RemedyInput = {
    variant: over.variant ?? "trouble",
    condition_evidence: over.condition_evidence ?? ["the tray icon renders blank after the OS theme flips"],
    condition_normalized: over.condition_normalized ?? null,
    action_evidence: over.action_evidence ?? ["re-register the template image on nativeTheme.updated"],
    evidence_state: over.evidence_state ?? "OBSERVED_SUCCESS",
    source: over.source ?? { kind: "memory", id: "mem-1", title: "tray icon", node_path: null },
    observed_at: over.observed_at ?? "2026-09-01T00:00:00.000Z",
  };
  return stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" });
}
const approved = (a: RemedyAtom) => approveRemedy(a, "user-1");
const ctx = (path: string | null): AgentExecutionContext => ({ workspace_id: "ws", path, compiled_at: "2026-09-10T00:00:00.000Z" });

describe("scopeApplies", () => {
  it("global scope applies everywhere including no-path", () => {
    expect(scopeApplies(null, "/apps/web/x.ts")).toBe(true);
    expect(scopeApplies("", "/apps/api")).toBe(true);
    expect(scopeApplies(null, null)).toBe(true);
  });
  it("path scope applies to itself and descendants, not siblings or parents", () => {
    expect(scopeApplies("apps/web", "apps/web")).toBe(true);
    expect(scopeApplies("apps/web", "apps/web/button.tsx")).toBe(true);
    expect(scopeApplies("apps/web", "apps/api/server.ts")).toBe(false);
    expect(scopeApplies("apps/web", "apps")).toBe(false);
    expect(scopeApplies("apps/web", "apps/website")).toBe(false); // prefix but not a path boundary
  });
  it("a path scope never applies when the execution has no path", () => {
    expect(scopeApplies("apps/web", null)).toBe(false);
  });
});

describe("lifecycle eligibility (the hard gates)", () => {
  const scoped = (a: RemedyAtom): ScopedRemedy => ({ atom: a, scope: null });
  it("delivers an approved, active, strong-evidence remedy", () => {
    const ir = compileAgentKnowledgeIR([scoped(approved(atom()))], ctx("apps/web/x.ts"));
    expect(ir.entries).toHaveLength(1);
  });
  it("never delivers a PROPOSED remedy", () => {
    const ir = compileAgentKnowledgeIR([scoped(atom())], ctx("x"));
    expect(ir.entries).toHaveLength(0);
  });
  it("never delivers a REJECTED remedy", () => {
    const ir = compileAgentKnowledgeIR([scoped(rejectRemedy(atom(), "user-1"))], ctx("x"));
    expect(ir.entries).toHaveLength(0);
  });
  it("never delivers weak evidence even when approved+active", () => {
    for (const st of ["SPECULATIVE", "ATTEMPTED", "FAILED", "SUPERSEDED"] as RemedyEvidenceState[]) {
      const ir = compileAgentKnowledgeIR([scoped(approved(atom({ evidence_state: st })))], ctx("x"));
      expect(ir.entries, st).toHaveLength(0);
    }
  });
  it("delivers each of the three deliverable states", () => {
    for (const st of ["HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS"] as RemedyEvidenceState[]) {
      const ir = compileAgentKnowledgeIR([scoped(approved(atom({ evidence_state: st })))], ctx("x"));
      expect(ir.entries, st).toHaveLength(1);
    }
  });
});

describe("scope filtering through the compiler", () => {
  it("delivers a /apps/web remedy under /apps/web but not /apps/api", () => {
    const a: ScopedRemedy = { atom: approved(atom({ source: { kind: "memory", id: "m", title: "t", node_path: null } })), scope: "apps/web" };
    expect(compileAgentKnowledgeIR([a], ctx("apps/web/button.tsx")).entries).toHaveLength(1);
    expect(compileAgentKnowledgeIR([a], ctx("apps/api/server.ts")).entries).toHaveLength(0);
  });
  it("a global remedy reaches every path and the no-path case", () => {
    const a: ScopedRemedy = { atom: approved(atom()), scope: null };
    expect(compileAgentKnowledgeIR([a], ctx("apps/api/server.ts")).entries).toHaveLength(1);
    expect(compileAgentKnowledgeIR([a], ctx(null)).entries).toHaveLength(1);
  });
  it("a path-scoped remedy is not delivered to a no-path execution", () => {
    const a: ScopedRemedy = { atom: approved(atom()), scope: "apps/web" };
    expect(compileAgentKnowledgeIR([a], ctx(null)).entries).toHaveLength(0);
  });
});

describe("budget, ordering, dedup", () => {
  it("is bounded and reports truncation", () => {
    const many: ScopedRemedy[] = Array.from({ length: 100 }, (_, i) => ({
      atom: approved(atom({ action_evidence: [`fix number ${i} applied deterministically here`], observed_at: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` })),
      scope: null,
    }));
    const ir = compileAgentKnowledgeIR(many, ctx("x"), { budget: 8 });
    expect(ir.entries).toHaveLength(8);
    expect(ir.provenance.eligible).toBe(100);
    expect(ir.provenance.truncated).toBe(true);
  });
  it("orders most-specific scope, then strongest evidence, deterministically", () => {
    const weakDeep: ScopedRemedy = { atom: approved(atom({ evidence_state: "OBSERVED_SUCCESS", action_evidence: ["deep observed fix applied to the button"] })), scope: "apps/web/components" };
    const strongShallow: ScopedRemedy = { atom: approved(atom({ evidence_state: "HUMAN_AUTHORED", action_evidence: ["shallow standing guidance for the whole app"] })), scope: "apps" };
    const ir = compileAgentKnowledgeIR([strongShallow, weakDeep], ctx("apps/web/components/x.tsx"));
    expect(ir.entries[0]!.scope).toBe("/apps/web/components"); // specificity beats strength
  });
  it("collapses duplicate atoms by fingerprint", () => {
    const a = approved(atom());
    const ir = compileAgentKnowledgeIR([{ atom: a, scope: null }, { atom: a, scope: null }], ctx("x"));
    expect(ir.entries).toHaveLength(1);
  });
});

describe("projection and render", () => {
  it("projects only agent-useful fields and no raw metadata", () => {
    const adv = projectRemedyToAdvisory(approved(atom()), "/apps/web");
    expect(adv).toMatchObject({ type: "remedy", authority: "advisory", variant: "trouble", scope: "/apps/web" });
    expect(Object.keys(adv)).not.toContain("created_at");
    expect(Object.keys(adv)).not.toContain("approved_by");
  });
  it("uses paraphrase marker when the condition was composed, not source-grounded", () => {
    const composed = approved(atom({ condition_evidence: [], condition_normalized: "the cache goes stale after a schema change" }));
    const adv = projectRemedyToAdvisory(composed, null);
    expect(adv.condition_grounded).toBe(false);
    const ir = { execution_context: ctx("x"), entries: [adv], provenance: { eligible: 1, delivered: 1, budget: 8, truncated: false } };
    expect(renderAgentKnowledgeIR(ir)).toContain("(paraphrased)");
  });
  it("renders a subordinate advisory section, never as authority", () => {
    const ir = compileAgentKnowledgeIR([{ atom: approved(atom()), scope: null }], ctx("x"));
    const md = renderAgentKnowledgeIR(ir);
    expect(md).toContain("advisory only");
    expect(md).toContain("never override a rule, a constraint");
    expect(md).toContain("observed to work");
  });
  it("renders empty string when nothing is deliverable", () => {
    expect(renderAgentKnowledgeIR(compileAgentKnowledgeIR([], ctx("x")))).toBe("");
  });
});

describe("selectAdvisoriesForPath (the hook-index selection twin)", () => {
  const stub = (ref: string) => ({ ref, line: `- advisory ${ref}` });
  const index = {
    path_advisories: {
      "/apps/web": [stub("web-1")],
      "/apps/web/components": [stub("comp-1")],
      "/apps/api": [stub("api-1")],
    },
    project_advisories: [stub("global-1")],
  };
  it("collects ancestor-scoped + global for a deep path, most-specific first", () => {
    const sel = selectAdvisoriesForPath(index, "/apps/web/components/button.tsx").map((s) => s.ref);
    expect(sel).toEqual(["comp-1", "web-1", "global-1"]);
    expect(sel).not.toContain("api-1");
  });
  it("a sibling path gets only global, never the other branch", () => {
    expect(selectAdvisoriesForPath(index, "/apps/api/server.ts").map((s) => s.ref)).toEqual(["api-1", "global-1"]);
  });
  it("an unrelated path gets only global", () => {
    expect(selectAdvisoriesForPath(index, "/docs/readme.md").map((s) => s.ref)).toEqual(["global-1"]);
  });
  it("no path (root) gets only global", () => {
    expect(selectAdvisoriesForPath(index, null).map((s) => s.ref)).toEqual(["global-1"]);
  });
  it("respects the budget", () => {
    const big = { project_advisories: Array.from({ length: 20 }, (_, i) => stub(`g${i}`)) };
    expect(selectAdvisoriesForPath(big, "/x", 5)).toHaveLength(5);
  });
  it("renders selected stubs as the subordinate section, or empty", () => {
    expect(renderAdvisorySection([])).toBe("");
    const md = renderAdvisorySection(selectAdvisoriesForPath(index, "/apps/web/x.ts"));
    expect(md).toContain("advisory only");
    expect(md).toContain("- advisory web-1");
  });
});
