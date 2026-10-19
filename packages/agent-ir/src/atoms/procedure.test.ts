// SPDX-License-Identifier: Apache-2.0
/**
 * PROCEDURE lifecycle, delivery gate and ordering identity: step order is part of the fingerprint and
 * survives storage. Validation of extracted steps is tested beside the validator, which is proprietary.
 */
import { describe, it, expect } from "vitest";
import {
  stampProposedProcedure,
  approveProcedure,
  rejectProcedure,
  isProcedureDeliverable,
  parseProcedureAtom,
  type ProcedureInput,
} from "./procedure.js";

const base = (over: Partial<ProcedureInput> = {}): ProcedureInput => ({
  operation_evidence: ["adding a database migration"], operation_normalized: null,
  steps: ["create migration", "update schema version", "run migration tests"],
  source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("PROCEDURE lifecycle + delivery gate + ordering identity", () => {
  it("propose -> approve makes it deliverable; reject does not", () => {
    const atom = stampProposedProcedure(base(), { now: "t" });
    expect(isProcedureDeliverable(atom)).toBe(false);
    expect(isProcedureDeliverable(approveProcedure(atom, "u"))).toBe(true);
    expect(isProcedureDeliverable(rejectProcedure(atom, "u"))).toBe(false);
  });
  it("step order is part of identity: a reordered procedure is a different fingerprint", () => {
    const a = stampProposedProcedure(base({ steps: ["create migration", "run migration tests"] }), { now: "t" });
    const b = stampProposedProcedure(base({ steps: ["run migration tests", "create migration"] }), { now: "t" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it("stored steps preserve order exactly", () => {
    const atom = stampProposedProcedure(base(), { now: "t" });
    expect(atom.steps).toEqual(["create migration", "update schema version", "run migration tests"]);
  });
  it("round-trips through parseProcedureAtom and rejects a foreign kind", () => {
    const atom = approveProcedure(stampProposedProcedure(base(), { now: "t" }), "u");
    expect(parseProcedureAtom(JSON.parse(JSON.stringify(atom)))).toMatchObject({ kind: "procedure", status: "active", steps: atom.steps });
    expect(parseProcedureAtom({ kind: "selection" })).toBeNull();
    expect(parseProcedureAtom({ kind: "procedure", steps: ["only one"] })).toBeNull(); // too few steps
  });
});
