// SPDX-License-Identifier: Apache-2.0
/**
 * The two properties this file exists to protect are the ones eight generations of research
 * paid for: weak evidence never becomes deliverable, and human authority comes from an approval
 * rather than from where the text was found.
 */
import { describe, it, expect } from "vitest";

import { DELIVERABLE_EVIDENCE_STATES, REMEDY_EVIDENCE_STATES, approveRemedy, isRemedyDeliverable, parseRemedyAtom, parseRemedyAtoms, rejectRemedy, type RemedyInput } from "./remedy.js";
import { remedyFingerprint, stampProposedRemedy } from "./remedy-fingerprint.js";

const input = (o: Partial<RemedyInput> = {}): RemedyInput => ({
  variant: "trouble",
  condition_evidence: ["The icon renders blank after the OS theme flips"],
  condition_normalized: null,
  action_evidence: ["re-registering the template image on the nativeTheme updated event"],
  evidence_state: "OBSERVED_SUCCESS",
  source: { kind: "memory", id: "m1", title: "Tray icon goes blank after a theme switch", node_path: "/packages/app" },
  observed_at: "2026-09-01T00:00:00.000Z",
  ...o,
});

describe("identity is deterministic, which is what makes dedup and rejection work", () => {
  it("gives the same fingerprint for the same evidence", () => {
    expect(remedyFingerprint(input())).toBe(remedyFingerprint(input()));
  });

  it("ignores whitespace reflow in the evidence", () => {
    const a = remedyFingerprint(input());
    const b = remedyFingerprint(input({
      action_evidence: ["re-registering the template image\non the nativeTheme  updated event"],
    }));
    expect(b).toBe(a);
  });

  it("ignores the order of several spans", () => {
    const a = remedyFingerprint(input({ action_evidence: ["one span here ok", "another span here"] }));
    const b = remedyFingerprint(input({ action_evidence: ["another span here", "one span here ok"] }));
    expect(a).toBe(b);
  });

  it("changes when the source changes", () => {
    const other = input({ source: { kind: "memory", id: "m2", title: "x", node_path: null } });
    expect(remedyFingerprint(other)).not.toBe(remedyFingerprint(input()));
  });

  it("changes when the evidence changes", () => {
    expect(remedyFingerprint(input({ action_evidence: ["a completely different action"] })))
      .not.toBe(remedyFingerprint(input()));
  });

  it("uses the fingerprint as the atom id", () => {
    const atom = stampProposedRemedy(input(), { now: "2026-09-08T00:00:00.000Z" });
    expect(atom.id).toBe(atom.fingerprint);
    expect(atom.id).toBe(remedyFingerprint(input()));
  });
});

describe("lifecycle", () => {
  const now = "2026-09-08T00:00:00.000Z";

  it("stamps a proposal as inferred and proposed, never approved", () => {
    const atom = stampProposedRemedy(input(), { now });
    expect(atom).toMatchObject({ authority: "inferred", status: "proposed", approved_by: null });
    expect(isRemedyDeliverable(atom)).toBe(false);
  });

  it("drops the composed wording when verbatim evidence exists", () => {
    const atom = stampProposedRemedy(input({ condition_normalized: "should be ignored" }), { now });
    expect(atom.condition_normalized).toBeNull();
    expect(atom.condition_evidence.length).toBe(1);
  });

  it("keeps the composed wording when there is no verbatim condition", () => {
    const atom = stampProposedRemedy(
      input({ condition_evidence: [], condition_normalized: "the icon goes blank" }), { now });
    expect(atom.condition_evidence).toEqual([]);
    expect(atom.condition_normalized).toBe("the icon goes blank");
  });

  it("approval makes it deliverable and records who", () => {
    const atom = approveRemedy(stampProposedRemedy(input(), { now }), "sertan");
    expect(atom).toMatchObject({ authority: "human", status: "active", approved_by: "sertan" });
    expect(isRemedyDeliverable(atom)).toBe(true);
  });

  it("approval never touches evidence, provenance or evidence state", () => {
    const before = stampProposedRemedy(input(), { now });
    const after = approveRemedy(before, "sertan");
    expect(after.condition_evidence).toEqual(before.condition_evidence);
    expect(after.action_evidence).toEqual(before.action_evidence);
    expect(after.evidence_state).toBe(before.evidence_state);
    expect(after.source).toEqual(before.source);
    expect(after.observed_at).toBe(before.observed_at);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("rejection persists and is not deliverable", () => {
    const atom = rejectRemedy(stampProposedRemedy(input(), { now }), "sertan");
    expect(atom.status).toBe("rejected");
    expect(atom.authority).toBe("inferred");
    expect(isRemedyDeliverable(atom)).toBe(false);
  });

  it("a rejected atom keeps its fingerprint, so the same evidence cannot come back as new", () => {
    const proposed = stampProposedRemedy(input(), { now });
    expect(rejectRemedy(proposed, "sertan").fingerprint).toBe(proposed.fingerprint);
  });
});

describe("weak evidence can never be delivered, whoever approves it", () => {
  const now = "2026-09-08T00:00:00.000Z";

  it("admits only the three success states", () => {
    expect([...DELIVERABLE_EVIDENCE_STATES].sort())
      .toEqual(["HUMAN_AUTHORED", "OBSERVED_SUCCESS", "REPEATED_SUCCESS"]);
  });

  it("refuses delivery for attempted, failed, speculative and superseded even after approval", () => {
    for (const state of ["ATTEMPTED", "FAILED", "SPECULATIVE", "SUPERSEDED"] as const) {
      const atom = approveRemedy(stampProposedRemedy(input({ evidence_state: state }), { now }), "sertan");
      expect(atom.status).toBe("active");
      expect(isRemedyDeliverable(atom)).toBe(false);
    }
  });

  it("delivers every success state once approved", () => {
    for (const state of ["HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS"] as const) {
      const atom = approveRemedy(stampProposedRemedy(input({ evidence_state: state }), { now }), "sertan");
      expect(isRemedyDeliverable(atom)).toBe(true);
    }
  });

  it("never reaches the compiler-only `verified` authority", () => {
    const atom = approveRemedy(stampProposedRemedy(input(), { now }), "sertan");
    expect(atom.authority).not.toBe("verified");
  });

  it("a rule source buys nothing on its own", () => {
    const atom = stampProposedRemedy(input({
      variant: "bind",
      condition_evidence: ["Never spawn an engine child directly."],
      action_evidence: ["Route engine child spawns through spawnManaged"],
      evidence_state: "HUMAN_AUTHORED",
      source: { kind: "rule", id: "r2", title: "spawnManaged", node_path: null },
    }), { now });
    expect(isRemedyDeliverable(atom)).toBe(false);
  });
});

describe("round trip and malformed input", () => {
  const now = "2026-09-08T00:00:00.000Z";

  it("survives a JSON round trip unchanged", () => {
    const atom = approveRemedy(stampProposedRemedy(input(), { now }), "sertan");
    const back = parseRemedyAtom(JSON.parse(JSON.stringify(atom)));
    expect(back).toEqual(atom);
  });

  it("round trips a composed-condition atom", () => {
    const atom = stampProposedRemedy(input({ condition_evidence: [], condition_normalized: "composed" }), { now });
    expect(parseRemedyAtom(JSON.parse(JSON.stringify(atom)))).toEqual(atom);
  });

  it("round trips a rejected atom", () => {
    const atom = rejectRemedy(stampProposedRemedy(input(), { now }), "sertan");
    expect(parseRemedyAtom(JSON.parse(JSON.stringify(atom)))).toEqual(atom);
  });

  it("returns null rather than throwing on anything malformed", () => {
    const atom = stampProposedRemedy(input(), { now }) as unknown as Record<string, unknown>;
    for (const bad of [
      null, undefined, 42, "string", {}, [],
      { ...atom, kind: "constraint" },
      { ...atom, variant: "sideways" },
      { ...atom, evidence_state: "INVENTED" },
      { ...atom, status: "half-approved" },
      { ...atom, authority: "verified" },
      { ...atom, action_evidence: [] },
      { ...atom, source: null },
      { ...atom, source: { kind: "skill", id: "s1" } },
      { ...atom, id: undefined, fingerprint: undefined },
    ]) {
      expect(() => parseRemedyAtom(bad)).not.toThrow();
      expect(parseRemedyAtom(bad)).toBeNull();
    }
  });

  it("parses a list, skipping malformed entries and keeping order", () => {
    const a = stampProposedRemedy(input(), { now });
    const b = stampProposedRemedy(input({ source: { kind: "memory", id: "m9", title: "b", node_path: null } }), { now });
    const parsed = parseRemedyAtoms([a, { kind: "remedy", variant: "nope" }, b]);
    expect(parsed.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it("parses a JSON string, and returns an empty list for junk", () => {
    const a = stampProposedRemedy(input(), { now });
    expect(parseRemedyAtoms(JSON.stringify([a]))).toEqual([a]);
    expect(parseRemedyAtoms("not json")).toEqual([]);
    expect(parseRemedyAtoms("{}")).toEqual([]);
  });

  it("keeps every declared evidence state parseable", () => {
    for (const state of REMEDY_EVIDENCE_STATES) {
      const atom = stampProposedRemedy(input({ evidence_state: state }), { now });
      expect(parseRemedyAtom(JSON.parse(JSON.stringify(atom)))?.evidence_state).toBe(state);
    }
  });
});
