// SPDX-License-Identifier: Apache-2.0
// Acceptance criteria 2 and 7 of the constraint slice design live here:
// a constraint written through the knowledge path must not compile to anything
// enforceable, and an invalid one must be refused at write time.

import { describe, expect, it } from "vitest";

import {
  approveConstraint,
  compileRuleConstraints,
  isEnforceable,
  parseRuleConstraints,
  stampProposedConstraint,
  validateConstraintInput,
  type ConstraintInput,
  type RuleConstraint,
} from "./constraint.js";

const RULE_33: ConstraintInput = {
  mode: "forbid",
  pattern: "cursor:\\s*pointer",
  flags: "i",
  message: "Use a real <button> or <a>; they carry the pointer cursor and the semantics.",
};

function proposed(input: ConstraintInput = RULE_33): RuleConstraint {
  const check = validateConstraintInput(input);
  if (!check.ok) throw new Error(`fixture should validate: ${check.message}`);
  return stampProposedConstraint(check.value, { id: "c-1", now: "2026-09-03T00:00:00.000Z" });
}

describe("validateConstraintInput", () => {
  it("accepts the rule 33 constraint and normalises flags", () => {
    const result = validateConstraintInput({ mode: "forbid", pattern: "cursor:\\s*pointer", message: RULE_33.message });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.flags).toBe("");
  });

  it("rejects an uncompilable regex", () => {
    const result = validateConstraintInput({ ...RULE_33, pattern: "cursor:(\\s*pointer" });
    expect(result).toMatchObject({ ok: false, code: "constraint_pattern_uncompilable" });
  });

  it("rejects the g flag, because .test() would then alternate on identical input", () => {
    const result = validateConstraintInput({ ...RULE_33, flags: "gi" });
    expect(result).toMatchObject({ ok: false, code: "constraint_flags_unsupported" });
  });

  it("rejects a duplicated flag", () => {
    expect(validateConstraintInput({ ...RULE_33, flags: "ii" })).toMatchObject({
      ok: false,
      code: "constraint_flags_unsupported",
    });
  });

  it("rejects a pattern that matches the empty string", () => {
    // `.*` compiles, is short, and would deny every single edit.
    const result = validateConstraintInput({ ...RULE_33, pattern: "(?:cursor)?.*" });
    expect(result).toMatchObject({ ok: false, code: "constraint_pattern_matches_empty" });
  });

  it("rejects a constraint with no usable remedy message", () => {
    expect(validateConstraintInput({ ...RULE_33, message: "no" })).toMatchObject({
      ok: false,
      code: "constraint_message_too_short",
    });
  });

  it("rejects patterns outside the length bounds", () => {
    expect(validateConstraintInput({ ...RULE_33, pattern: "ab" })).toMatchObject({
      ok: false,
      code: "constraint_pattern_too_short",
    });
    expect(validateConstraintInput({ ...RULE_33, pattern: "a".repeat(201) })).toMatchObject({
      ok: false,
      code: "constraint_pattern_too_long",
    });
  });

  it("rejects an unsupported mode", () => {
    expect(validateConstraintInput({ ...RULE_33, mode: "require" as "forbid" })).toMatchObject({
      ok: false,
      code: "constraint_mode_unsupported",
    });
  });
});

/**
 * The rule body the projection is asked about. Human-approved atoms are indifferent to
 * it by design; the grounding block below is where it starts to matter.
 */
const BODY = "Never apply `cursor: pointer` to a div. Use a real button or anchor.";

describe("authority", () => {
  it("stamps every knowledge-path write as inferred and proposed", () => {
    const c = proposed();
    expect(c.authority).toBe("inferred");
    expect(c.status).toBe("proposed");
    expect(c.approved_by).toBeNull();
    expect(isEnforceable(c)).toBe(false);
  });

  it("does not compile a proposed constraint to anything enforceable", () => {
    expect(compileRuleConstraints([proposed()], BODY)).toBeNull();
  });

  it("compiles only after an explicit human approval", () => {
    const approved = approveConstraint(proposed(), "user-1");
    expect(approved.authority).toBe("human");
    expect(approved.status).toBe("active");
    expect(approved.approved_by).toBe("user-1");
    expect(compileRuleConstraints([approved], BODY)).toEqual({
      enforcement: "strict",
      block_pattern: { source: "cursor:\\s*pointer", flags: "i", message: RULE_33.message },
    });
  });

  it("needs both halves of the gate, so one flipped field cannot grant enforcement", () => {
    const base = proposed();
    expect(compileRuleConstraints([{ ...base, status: "active" }], BODY)).toBeNull();
    expect(compileRuleConstraints([{ ...base, authority: "human" }], BODY)).toBeNull();
  });

  it("leaves a rule with no constraints exactly as it is today", () => {
    expect(compileRuleConstraints([], BODY)).toBeNull();
    expect(compileRuleConstraints(null, BODY)).toBeNull();
    expect(compileRuleConstraints(undefined, BODY)).toBeNull();
  });

  it("degrades a stored constraint that no longer validates to not-enforced", () => {
    const approved = approveConstraint(proposed(), "user-1");
    const broken: RuleConstraint = {
      ...approved,
      match: { kind: "regex", flags: approved.match!.flags, pattern: "cursor:(" },
    };
    expect(compileRuleConstraints([broken], BODY)).toBeNull();
  });

  it("compiles the first enforceable constraint and skips proposed ones before it", () => {
    const approved = approveConstraint(
      { ...proposed(), id: "c-2", match: { kind: "regex", pattern: "float\\s+money", flags: "" } },
      "user-1",
    );
    const compiled = compileRuleConstraints([proposed(), approved], BODY);
    expect(compiled?.block_pattern?.source).toBe("float\\s+money");
  });
});

describe("parseRuleConstraints", () => {
  it("round-trips a stored atom from jsonb and from a TEXT column", () => {
    const c = approveConstraint(proposed(), "user-1");
    expect(parseRuleConstraints([c])).toEqual([c]);
    expect(parseRuleConstraints(JSON.stringify([c]))).toEqual([c]);
  });

  it("drops malformed rows rather than repairing them", () => {
    expect(parseRuleConstraints([{ mode: "forbid" }])).toEqual([]);
    expect(parseRuleConstraints([{ ...proposed(), authority: "sudo" }])).toEqual([]);
    expect(parseRuleConstraints([{ ...proposed(), status: "enabled" }])).toEqual([]);
    expect(parseRuleConstraints([{ ...proposed(), match: { kind: "glob", pattern: "*" } }])).toEqual([]);
    expect(parseRuleConstraints("not json")).toEqual([]);
    expect(parseRuleConstraints(null)).toEqual([]);
  });

  it("never promotes authority while parsing", () => {
    const [parsed] = parseRuleConstraints([proposed()]);
    expect(parsed?.authority).toBe("inferred");
    expect(parsed?.status).toBe("proposed");
  });
});
