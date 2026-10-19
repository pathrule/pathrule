// SPDX-License-Identifier: Apache-2.0
/**
 * V33 end to end through compileKnowledgeIR: conflicting SELECTIONs are withheld without an applicable
 * precedence, and an approved precedence delivers the correct winner. Enforcement can never be defeated
 * by a precedence (a forbidden winner is dropped first). Traces are exposed.
 */
import { describe, it, expect } from "vitest";
import { compileKnowledgeIR, type AgentExecutionContext, type ScopedSelection, type ScopedPrecedence } from "./agent-ir.js";
import { stampProposedSelection } from "../atoms/selection-fingerprint.js";
import { approveSelection, type SelectionInput } from "../atoms/selection.js";
import { stampProposedPrecedence, approvePrecedence, type PrecedenceInput } from "../atoms/precedence.js";

const ctx = (path: string | null): AgentExecutionContext => ({ workspace_id: "ws", path, compiled_at: "2026-09-14T00:00:00.000Z" });
let n = 0;
function sel(preferred: string, context: string, scope: string | null): ScopedSelection {
  const input: SelectionInput = { context_evidence: [context], context_normalized: null, preferred_evidence: [preferred], alternative_evidence: [], strength: "ESTABLISHED", source: { kind: "memory", id: `s${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approveSelection(stampProposedSelection(input, { now: "t" }), "u"), scope };
}
function prec(winner: string, loser: string, scope: string | null): ScopedPrecedence {
  const input: PrecedenceInput = { winner_evidence: [winner], winner_normalized: null, loser_evidence: [loser], loser_normalized: null, relationship_evidence: [`${winner} overrides ${loser}`], condition_normalized: null, source: { kind: "memory", id: `p${++n}`, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z" };
  return { atom: approvePrecedence(stampProposedPrecedence(input, { now: "t" }), "u"), scope };
}

describe("V33 compileKnowledgeIR + PRECEDENCE", () => {
  it("two conflicting selections with NO precedence -> both withheld (UNRESOLVED)", () => {
    const ir = compileKnowledgeIR({ selections: [sel("pnpm", "package manager", "/apps/web"), sel("npm", "package manager", "/apps/web")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.filter((e) => e.type === "selection")).toHaveLength(0);
    expect(ir.conflicts?.[0]?.reason_code).toBe("UNRESOLVED_CONFLICT");
  });

  it("an APPROVED applicable precedence delivers the winner and withholds the loser", () => {
    const ir = compileKnowledgeIR({
      selections: [sel("pnpm", "package manager", "/apps/web"), sel("npm", "package manager", "/apps/web")],
      precedences: [prec("pnpm", "npm", "/apps/web")],
    }, ctx("/apps/web/x.ts"));
    const sels = ir.entries.filter((e) => e.type === "selection");
    expect(sels).toHaveLength(1);
    expect((sels[0] as { preferred: string }).preferred).toBe("pnpm");
    expect(ir.conflicts?.[0]?.reason_code).toBe("EXPLICIT_PRECEDENCE");
  });

  it("a PROPOSED (unapproved) precedence has NO effect -> still withheld", () => {
    const proposed: ScopedPrecedence = { atom: stampProposedPrecedence({ winner_evidence: ["pnpm"], winner_normalized: null, loser_evidence: ["npm"], loser_normalized: null, relationship_evidence: ["pnpm overrides npm"], condition_normalized: null, source: { kind: "memory", id: "pp", title: "t", node_path: null }, observed_at: "t" }, { now: "t" }), scope: "/apps/web" };
    const ir = compileKnowledgeIR({ selections: [sel("pnpm", "package manager", "/apps/web"), sel("npm", "package manager", "/apps/web")], precedences: [proposed] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.filter((e) => e.type === "selection")).toHaveLength(0);
  });

  it("a wrong-scope precedence has NO effect -> still withheld", () => {
    const ir = compileKnowledgeIR({ selections: [sel("pnpm", "package manager", "/apps/web"), sel("npm", "package manager", "/apps/web")], precedences: [prec("pnpm", "npm", "/apps/api")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.filter((e) => e.type === "selection")).toHaveLength(0);
  });

  it("ENFORCEMENT ISOLATION: a precedence naming a forbidden winner cannot deliver it", () => {
    // 'eval' is forbidden by a constraint; even a precedence 'eval > safeParse' cannot deliver eval.
    const ir = compileKnowledgeIR({
      selections: [sel("eval", "parsing", "/apps/web"), sel("safeParse", "parsing", "/apps/web")],
      precedences: [prec("eval", "safeParse", "/apps/web")],
      forbidden: ["eval"],
    }, ctx("/apps/web/x.ts"));
    const rendered = ir.entries.filter((e) => e.type === "selection");
    // eval was dropped by the forbidden gate BEFORE conflict resolution; safeParse is the lone
    // remaining selection (no conflict), so a forbidden winner is never delivered.
    expect(rendered.every((e) => (e as { preferred: string }).preferred !== "eval")).toBe(true);
  });

  it("non-conflicting selections in different contexts are both delivered", () => {
    const ir = compileKnowledgeIR({ selections: [sel("pnpm", "package manager", "/apps/web"), sel("zod", "validation", "/apps/web")] }, ctx("/apps/web/x.ts"));
    expect(ir.entries.filter((e) => e.type === "selection")).toHaveLength(2);
  });
});
