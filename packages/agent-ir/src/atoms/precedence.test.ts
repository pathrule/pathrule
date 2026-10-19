// SPDX-License-Identifier: Apache-2.0
/**
 * PRECEDENCE lifecycle: an approved, active precedence is what the conflict compiler uses, and a
 * rejected one never is. Validation of extracted spans is tested beside the validator, which is proprietary.
 */
import { describe, it, expect } from "vitest";
import {
  stampProposedPrecedence, approvePrecedence, rejectPrecedence, isPrecedenceActive, parsePrecedenceAtom,
  type PrecedenceInput,
} from "./precedence.js";

const base = (over: Partial<PrecedenceInput> = {}): PrecedenceInput => ({
  winner_evidence: ["the repository rule"], winner_normalized: null,
  loser_evidence: ["the organization default"], loser_normalized: null,
  relationship_evidence: ["the repository rule overrides the organization default"], condition_normalized: null,
  source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});
describe("PRECEDENCE lifecycle", () => {
  it("propose -> approve activates; reject does not", () => {
    const atom = stampProposedPrecedence(base(), { now: "t" });
    expect(isPrecedenceActive(atom)).toBe(false);
    expect(isPrecedenceActive(approvePrecedence(atom, "u"))).toBe(true);
    expect(isPrecedenceActive(rejectPrecedence(atom, "u"))).toBe(false);
  });
  it("round-trips through parsePrecedenceAtom and rejects a foreign kind", () => {
    const atom = approvePrecedence(stampProposedPrecedence(base(), { now: "t" }), "u");
    expect(parsePrecedenceAtom(JSON.parse(JSON.stringify(atom)))).toMatchObject({ kind: "precedence", status: "active" });
    expect(parsePrecedenceAtom({ kind: "context" })).toBeNull();
  });
});
