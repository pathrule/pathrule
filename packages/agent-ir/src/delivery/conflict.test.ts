// SPDX-License-Identifier: Apache-2.0
/**
 * The deterministic conflict compiler. Hard metrics: WRONG_WINNER = 0 (when precedence resolves, the
 * named winner is kept) and UNSAFE_CONFLICT_RESOLUTION = 0 (a conflict without an applicable,
 * unambiguous, acyclic precedence is always withheld, never guessed).
 */
import { describe, it, expect } from "vitest";
import { resolveConflicts, type ConflictCandidate, type PrecedenceEdge } from "./conflict.js";

const sel = (id: string, key: string, literal: string, scope: string | null = "/apps/web"): ConflictCandidate => ({ id, kind: "selection", conflictKey: key, literal, scope });
const edge = (winner: string, loser: string, scope: string | null = "/apps/web", ref = `p:${winner}>${loser}`): PrecedenceEdge => ({ ref, winner, loser, scope });

describe("resolveConflicts", () => {
  it("NO_CONFLICT: different keys coexist", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "date math", "date-fns")], [], "/apps/web/x.ts");
    expect(r.keep).toEqual(new Set(["a", "b"]));
    expect(r.withhold.size).toBe(0);
  });

  it("NO_CONFLICT: same key, same choice is agreement, not conflict", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "fetch")], [], "/apps/web/x.ts");
    expect(r.keep).toEqual(new Set(["a", "b"]));
  });

  it("UNRESOLVED_CONFLICT: same key, different choice, no precedence -> withhold BOTH", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [], "/apps/web/x.ts");
    expect(r.keep.size).toBe(0);
    expect(r.withhold).toEqual(new Set(["a", "b"]));
    expect(r.traces[0]!.reason_code).toBe("UNRESOLVED_CONFLICT");
  });

  it("EXPLICIT_PRECEDENCE: an applicable edge picks the correct winner (WRONG_WINNER = 0)", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [edge("fetch", "axios")], "/apps/web/x.ts");
    expect(r.keep).toEqual(new Set(["a"]));
    expect(r.withhold).toEqual(new Set(["b"]));
    expect(r.traces[0]!.reason_code).toBe("EXPLICIT_PRECEDENCE");
    expect(r.traces[0]!.winner_id).toBe("a");
  });

  it("WRONG_WINNER guard: the edge direction decides the winner, not id/order", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [edge("axios", "fetch")], "/apps/web/x.ts");
    expect(r.keep).toEqual(new Set(["b"])); // axios wins because the edge says so
  });

  it("AMBIGUOUS_PRECEDENCE: edges in both directions -> withhold both", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [edge("fetch", "axios"), edge("axios", "fetch")], "/apps/web/x.ts");
    expect(r.keep.size).toBe(0);
    expect(r.traces[0]!.reason_code).toBe("AMBIGUOUS_PRECEDENCE");
  });

  it("PRECEDENCE_CYCLE: A>B, B>C, C>A -> withhold all", () => {
    const r = resolveConflicts(
      [sel("a", "pm", "pnpm"), sel("b", "pm", "npm"), sel("c", "pm", "yarn")],
      [edge("pnpm", "npm"), edge("npm", "yarn"), edge("yarn", "pnpm")],
      "/apps/web/x.ts",
    );
    expect(r.keep.size).toBe(0);
    expect(r.traces[0]!.reason_code).toBe("PRECEDENCE_CYCLE");
  });

  it("partial precedence does not resolve a 3-way conflict (no champion -> withhold all)", () => {
    const r = resolveConflicts(
      [sel("a", "pm", "pnpm"), sel("b", "pm", "npm"), sel("c", "pm", "yarn")],
      [edge("pnpm", "npm")], // pnpm beats npm but not yarn
      "/apps/web/x.ts",
    );
    expect(r.keep.size).toBe(0);
    expect(r.traces[0]!.reason_code).toBe("UNRESOLVED_CONFLICT");
  });

  it("champion beats ALL others -> resolves a 3-way conflict", () => {
    const r = resolveConflicts(
      [sel("a", "pm", "pnpm"), sel("b", "pm", "npm"), sel("c", "pm", "yarn")],
      [edge("pnpm", "npm"), edge("pnpm", "yarn")],
      "/apps/web/x.ts",
    );
    expect(r.keep).toEqual(new Set(["a"]));
  });

  it("UNSAFE_CONFLICT_RESOLUTION = 0: an out-of-scope edge has no effect -> still withheld", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [edge("fetch", "axios", "/apps/api")], "/apps/web/x.ts");
    expect(r.keep.size).toBe(0);
    expect(r.traces[0]!.reason_code).toBe("UNRESOLVED_CONFLICT");
  });

  it("scope-aware: the same edge resolves the conflict when the execution is in the edge's scope", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch", "/apps/api"), sel("b", "http calls", "axios", "/apps/api")], [edge("fetch", "axios", "/apps/api")], "/apps/api/x.ts");
    expect(r.keep).toEqual(new Set(["a"]));
  });

  it("emits a machine-readable trace with candidate + precedence ids", () => {
    const r = resolveConflicts([sel("a", "http calls", "fetch"), sel("b", "http calls", "axios")], [edge("fetch", "axios")], "/apps/web/x.ts");
    const t = r.traces[0]!;
    expect(t.candidate_ids.sort()).toEqual(["a", "b"]);
    expect(t.applicable_precedence_ids).toEqual(["p:fetch>axios"]);
    expect(t.withheld_ids).toEqual(["b"]);
  });
});
