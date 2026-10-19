// SPDX-License-Identifier: Apache-2.0
/**
 * RATIONALE lifecycle: an approved rationale is delivered and a rejected one is not. Validation of
 * extracted spans is tested beside the validator, which is proprietary.
 */
import { describe, it, expect } from "vitest";
import {
  stampProposedRationale, approveRationale, rejectRationale, isRationaleDeliverable, parseRationaleAtom,
  type RationaleInput,
} from "./rationale.js";

const base = (over: Partial<RationaleInput> = {}): RationaleInput => ({
  subject_evidence: [], subject_normalized: "use ServerClient",
  reason_evidence: ["GeneratedClient cannot preserve streaming responses"],
  source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});
describe("RATIONALE lifecycle", () => {
  it("propose -> approve delivers; reject does not", () => {
    const atom = stampProposedRationale(base(), { now: "t" });
    expect(isRationaleDeliverable(atom)).toBe(false);
    expect(isRationaleDeliverable(approveRationale(atom, "u"))).toBe(true);
    expect(isRationaleDeliverable(rejectRationale(atom, "u"))).toBe(false);
  });
  it("round-trips through parseRationaleAtom and rejects a foreign kind", () => {
    const atom = approveRationale(stampProposedRationale(base(), { now: "t" }), "u");
    expect(parseRationaleAtom(JSON.parse(JSON.stringify(atom)))).toMatchObject({ kind: "rationale", status: "active" });
    expect(parseRationaleAtom({ kind: "context" })).toBeNull();
  });
});
