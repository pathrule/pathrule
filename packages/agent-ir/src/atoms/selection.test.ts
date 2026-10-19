// SPDX-License-Identifier: Apache-2.0
/**
 * SELECTION lifecycle and delivery gate: only an approved, active, ESTABLISHED preference reaches an
 * agent. Validation of extracted spans is tested beside the validator, which is proprietary.
 */
import { describe, it, expect } from "vitest";
import { stampProposedSelection, selectionFingerprint } from "./selection-fingerprint.js";
import {
  approveSelection,
  rejectSelection,
  isSelectionDeliverable,
  parseSelectionAtom,
  type SelectionInput,
} from "./selection.js";

const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  context_evidence: [], context_normalized: null, preferred_evidence: ["ServerClient"], alternative_evidence: [],
  strength: "ESTABLISHED", source: { kind: "memory", id: "m1", title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("SELECTION lifecycle + delivery gate", () => {
  it("propose -> approve makes an ESTABLISHED selection deliverable; reject does not", () => {
    const atom = stampProposedSelection(base({ preferred_evidence: ["ServerClient"] }), { now: "2026-09-01T00:00:00.000Z" });
    expect(atom.status).toBe("proposed");
    expect(isSelectionDeliverable(atom)).toBe(false);
    const approved = approveSelection(atom, "user-1");
    expect(isSelectionDeliverable(approved)).toBe(true);
    const rejected = rejectSelection(atom, "user-1");
    expect(isSelectionDeliverable(rejected)).toBe(false);
  });
  it("a SPECULATIVE or SUPERSEDED selection is never deliverable even when approved", () => {
    for (const strength of ["SPECULATIVE", "SUPERSEDED"] as const) {
      const atom = approveSelection(stampProposedSelection(base({ strength }), { now: "t" }), "user-1");
      expect(isSelectionDeliverable(atom)).toBe(false);
    }
  });
  it("fingerprint is stable and order-free over evidence", () => {
    const a = selectionFingerprint({ context_evidence: ["x"], preferred_evidence: ["A"], alternative_evidence: ["B"], source: { kind: "memory", id: "m" } });
    const b = selectionFingerprint({ context_evidence: ["x"], preferred_evidence: ["A"], alternative_evidence: ["B"], source: { kind: "memory", id: "m" } });
    expect(a).toBe(b);
  });
  it("round-trips through parseSelectionAtom", () => {
    const atom = approveSelection(stampProposedSelection(base(), { now: "t" }), "user-1");
    const parsed = parseSelectionAtom(JSON.parse(JSON.stringify(atom)));
    expect(parsed).toMatchObject({ kind: "selection", preferred_evidence: ["ServerClient"], status: "active", authority: "human" });
  });
  it("parse rejects a foreign kind", () => {
    expect(parseSelectionAtom({ kind: "remedy" })).toBeNull();
  });
});
