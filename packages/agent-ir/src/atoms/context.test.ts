// SPDX-License-Identifier: Apache-2.0
/**
 * CONTEXT lifecycle and the temporal delivery gate: only an approved, active, CURRENT fact reaches an
 * agent. Validation of extracted spans is tested beside the validator, which is proprietary.
 */
import { describe, it, expect } from "vitest";
import { stampProposedContext } from "./context-fingerprint.js";
import {
  approveContext, rejectContext, isContextDeliverable, parseContextAtom,
  type ContextInput,
} from "./context.js";

const base = (over: Partial<ContextInput> = {}): ContextInput => ({
  fact_evidence: ["The dashboard is rendered server-side"], fact_normalized: null, topic: null,
  temporal_status: "CURRENT", source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("CONTEXT lifecycle + temporal delivery gate", () => {
  it("propose -> approve delivers a CURRENT fact; reject does not", () => {
    const atom = stampProposedContext(base(), { now: "t" });
    expect(isContextDeliverable(atom)).toBe(false);
    expect(isContextDeliverable(approveContext(atom, "u"))).toBe(true);
    expect(isContextDeliverable(rejectContext(atom, "u"))).toBe(false);
  });
  it("a HISTORICAL / SUPERSEDED / SPECULATIVE fact is never delivered even when approved", () => {
    for (const temporal_status of ["HISTORICAL", "SUPERSEDED", "SPECULATIVE"] as const) {
      const atom = approveContext(stampProposedContext(base({ temporal_status }), { now: "t" }), "u");
      expect(isContextDeliverable(atom)).toBe(false);
    }
  });
  it("round-trips through parseContextAtom and rejects a foreign kind", () => {
    const atom = approveContext(stampProposedContext(base(), { now: "t" }), "u");
    expect(parseContextAtom(JSON.parse(JSON.stringify(atom)))).toMatchObject({ kind: "context", temporal_status: "CURRENT", status: "active" });
    expect(parseContextAtom({ kind: "rationale" })).toBeNull();
  });
});
