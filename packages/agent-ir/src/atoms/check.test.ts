// SPDX-License-Identifier: Apache-2.0
// CHECK's authority gate and its one new field, `scope_path`.

import { describe, expect, it } from "vitest";

import {
  approveCheck,
  compileRuleChecks,
  isCheckEnforceable,
  parseRuleChecks,
  pathInCheckScope,
  stampProposedCheck,
  validateCheckInput,
  type CheckInput,
  type RuleCheck,
} from "./check.js";
import { isCheckAtom, isConstraintAtom, parseRuleAtoms } from "./atoms.js";
import type { ResolvedCommand } from "../verification/script-resolution.js";

const SHARED_CHECK: CheckInput = {
  scope_path: "/packages/shared",
  command: "pnpm --filter @pathrule/shared test",
  message: "Behaviour changed under packages/shared, so its suite has to pass before this is done.",
};

function proposed(input: CheckInput = SHARED_CHECK): RuleCheck {
  const validated = validateCheckInput(input);
  if (!validated.ok) throw new Error(`fixture should validate: ${validated.message}`);
  return stampProposedCheck(validated.value, { id: "chk-1", now: "2026-09-03T00:00:00.000Z" });
}

describe("validateCheckInput", () => {
  it("accepts the real example and stores the canonical fingerprint", () => {
    const result = validateCheckInput(SHARED_CHECK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fingerprint).toBe("pnpm:test@package:@pathrule/shared");
  });

  it("refuses a command the evidence channel cannot canonicalise", () => {
    // Accepting this would create a check nothing could ever satisfy, so the block would
    // never clear. Refused at the write boundary instead.
    expect(validateCheckInput({ ...SHARED_CHECK, command: "bash scripts/verify.sh" })).toMatchObject({
      ok: false,
      code: "check_command_unfingerprintable",
    });
    // A pipe moves the exit code off the verification, so it is refused for the same reason.
    expect(validateCheckInput({ ...SHARED_CHECK, command: "pnpm test | tail -5" })).toMatchObject({
      ok: false,
      code: "check_command_unfingerprintable",
    });
  });
  it.each(["pytest tests/receiver; true","pytest tests/receiver &","pytest tests/receiver > /dev/null"])("refuses new ambiguous CHECK authoring without rewriting stored identity: %s",command=>{
    expect(validateCheckInput({...SHARED_CHECK,command})).toMatchObject({ok:false,code:"check_command_unfingerprintable"});
  });

  it("refuses a scope_path that is not workspace-relative", () => {
    for (const scope_path of ["packages/shared", "/packages/../etc", "/packages/*", ""]) {
      expect(validateCheckInput({ ...SHARED_CHECK, scope_path }), scope_path).toMatchObject({
        ok: false,
        code: "check_scope_path_invalid",
      });
    }
  });

  it("normalises a trailing slash and keeps the root", () => {
    const a = validateCheckInput({ ...SHARED_CHECK, scope_path: "/packages/shared/" });
    expect(a.ok && a.value.scope_path).toBe("/packages/shared");
    const b = validateCheckInput({ ...SHARED_CHECK, scope_path: "/", command: "pnpm -r test" });
    expect(b.ok && b.value.scope_path).toBe("/");
  });

  it("refuses a check with no usable message", () => {
    expect(validateCheckInput({ ...SHARED_CHECK, message: "run it" })).toMatchObject({
      ok: false,
      code: "check_message_too_short",
    });
  });
});

describe("authority", () => {
  it('keeps an unfamiliar but exact command inert until a human approves it',()=>{
    const input={scope_path:'/services/orders',command:'northstar-check audit --strict',message:'Run the exact audit command before completion.'};
    const validated=validateCheckInput(input);
    expect(validated.ok).toBe(true);
    if(!validated.ok)return;
    expect(validated.value.fingerprint).toMatch(/^opaque\.v1:[a-f0-9]{64}$/);
    const candidate=stampProposedCheck(validated.value,{id:'opaque-check',now:'2026-09-03T00:00:00.000Z'});
    expect(candidate).toMatchObject({authority:'inferred',status:'proposed',approved_by:null});
    expect(compileRuleChecks([candidate])).toBeNull();
    expect(compileRuleChecks([approveCheck(candidate,'reviewer')])).toMatchObject({command:input.command,fingerprint:validated.value.fingerprint});
  });
  it("never compiles a custom check on one flipped field, a forged fingerprint or an unsafe stored command", () => {
    const input = { scope_path: "/services/orders", command: "northstar-check audit --strict", message: "Run the exact audit command before completion." };
    const validated = validateCheckInput(input);
    if (!validated.ok) throw new Error(validated.message);
    const candidate = stampProposedCheck(validated.value, { id: "opaque-check", now: "2026-09-03T00:00:00.000Z" });
    expect(compileRuleChecks([{ ...candidate, authority: "human" }])).toBeNull();
    expect(compileRuleChecks([{ ...candidate, status: "active" }])).toBeNull();
    const approved = approveCheck(candidate, "reviewer");
    // A stored atom whose fingerprint names other argv, or whose command was rewritten
    // after approval, is dropped rather than repaired into an active check.
    expect(compileRuleChecks([{ ...approved, requires: { ...approved.requires, fingerprint: "opaque.v1:" + "0".repeat(64) } }])).toBeNull();
    expect(compileRuleChecks([{ ...approved, requires: { ...approved.requires, command: "northstar-check audit --relaxed" } }])).toBeNull();
    expect(compileRuleChecks([{ ...approved, requires: { ...approved.requires, command: "nohup nice" } }])).toBeNull();
    // Round trip through the stored shape keeps the proposal inert and the approval exact.
    expect(compileRuleChecks(parseRuleChecks(JSON.stringify([candidate])))).toBeNull();
    expect(compileRuleChecks(parseRuleChecks(JSON.stringify([approved])))).toEqual({ ...input, fingerprint: validated.value.fingerprint });
  });
  it.each(["nohup nice", "nice nohup X=1", "nohup northstar-check audit", "dash -c northstar-check", "./bin/northstar-check audit", "northstar-check audit | tail -1", "northstar-check audit; rm -rf x", "northstar-check $(id)"])(
    "refuses an unsafe custom command at the write boundary with a code, never a throw: %s",
    command => {
      const out = validateCheckInput({ scope_path: "/", command, message: "Run the project audit before finishing." });
      expect(out).toMatchObject({ ok: false, code: "check_command_unfingerprintable" });
    },
  );
  it("stamps every knowledge-path write as inferred and proposed", () => {
    const c = proposed();
    expect(c.authority).toBe("inferred");
    expect(c.status).toBe("proposed");
    expect(c.approved_by).toBeNull();
    expect(isCheckEnforceable(c)).toBe(false);
    expect(compileRuleChecks([c])).toBeNull();
  });

  it("compiles only after an explicit human approval", () => {
    const approved = approveCheck(proposed(), "user-1");
    expect(approved.authority).toBe("human");
    expect(approved.status).toBe("active");
    expect(compileRuleChecks([approved])).toEqual({
      scope_path: "/packages/shared",
      command: "pnpm --filter @pathrule/shared test",
      fingerprint: "pnpm:test@package:@pathrule/shared",
      message: SHARED_CHECK.message,
    });
  });
  it("preserves a preexisting approved lossy file-target identity byte for byte",()=>{
    const approved=approveCheck(proposed({...SHARED_CHECK,command:"pytest tests/receiver"}),"user-1");
    const serialized=JSON.stringify(approved);
    expect(approved.requires.fingerprint).toBe("pytest#narrowed");
    const parsed=parseRuleChecks(JSON.stringify([approved]));
    expect(parsed).toEqual([approved]);
    expect(compileRuleChecks(parsed)).toMatchObject({command:"pytest tests/receiver",fingerprint:"pytest#narrowed"});
    expect(JSON.stringify(approved)).toBe(serialized);
  });
  it("does not silently drop or migrate old approval at the new strict authoring boundary",()=>{
    const approved=approveCheck(proposed({...SHARED_CHECK,command:"pytest tests/receiver"}),"user-1");
    const historical={...approved,requires:{...approved.requires,command:"pytest tests/receiver; true"}};
    expect(validateCheckInput({...SHARED_CHECK,command:historical.requires.command}).ok).toBe(false);
    expect(compileRuleChecks([historical])).toMatchObject({command:historical.requires.command,fingerprint:"pytest#narrowed"});
    expect(parseRuleChecks(JSON.stringify([historical]))[0]?.requires).toEqual(historical.requires);
  });

  it("needs both halves of the gate", () => {
    const base = proposed();
    expect(compileRuleChecks([{ ...base, status: "active" }])).toBeNull();
    expect(compileRuleChecks([{ ...base, authority: "human" }])).toBeNull();
  });

  it("degrades a stored check whose fingerprint no longer matches its command", () => {
    // A tampered or stale row must not become a block nothing can clear.
    const approved = approveCheck(proposed(), "user-1");
    const drifted: RuleCheck = {
      ...approved,
      requires: { ...approved.requires, fingerprint: "pnpm:test@package:@pathrule/core" },
    };
    expect(compileRuleChecks([drifted])).toBeNull();
  });

  it("leaves a rule with no checks exactly as it was", () => {
    expect(compileRuleChecks([])).toBeNull();
    expect(compileRuleChecks(null)).toBeNull();
    expect(compileRuleChecks(undefined)).toBeNull();
  });
});

describe("resolution cannot be forged into authority", () => {
  const forged: ResolvedCommand = {
    status: "resolved",
    runs: "vitest run",
    chain: ["a lie"],
    reason: null,
  };
  const proven: ResolvedCommand = {
    status: "non_terminating",
    runs: "vitest",
    chain: [],
    reason: 'vitest watches unless given "run"',
  };

  it("compile refuses a stored atom whose resolution proved non-terminating", () => {
    // Belt and braces behind the write and approval boundaries. A veto, not a matching
    // authority: the compiled output below carries no resolution at all.
    const atom = approveCheck(proposed(), "user-1");
    const armed: RuleCheck = { ...atom, requires: { ...atom.requires, resolved: proven } };
    expect(compileRuleChecks([armed])).toBeNull();
  });

  it("compile output carries no resolution, so runtime cannot read it", () => {
    const atom = approveCheck(proposed(), "user-1");
    const withResolution: RuleCheck = { ...atom, requires: { ...atom.requires, resolved: forged } };
    const compiled = compileRuleChecks([withResolution]);
    expect(compiled).not.toBeNull();
    expect(Object.keys(compiled!).sort()).toEqual(["command", "fingerprint", "message", "scope_path"]);
    expect(JSON.stringify(compiled)).not.toContain("a lie");
  });

  it("a forged resolution cannot make a non-terminating command compile", () => {
    // The fingerprint check is what stops this: a claim in the atom does not change what
    // the command canonicalises to, and the veto reads the STATUS, not the claim's prose.
    const atom = approveCheck(proposed(), "user-1");
    const lying: RuleCheck = {
      ...atom,
      requires: { ...atom.requires, command: "pnpm vitest", fingerprint: atom.requires.fingerprint, resolved: forged },
    };
    // `pnpm vitest` does not canonicalise at all (watch by default), so the re-validation
    // inside compileRuleChecks fails before the resolution is even looked at.
    expect(compileRuleChecks([lying])).toBeNull();
  });

  it("a malformed stored resolution is dropped, never coerced to resolved", () => {
    const atom = approveCheck(proposed(), "user-1");
    const rows = parseRuleChecks([
      { ...atom, requires: { ...atom.requires, resolved: { status: "definitely-fine" } } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requires.resolved).toBeUndefined();
  });

  it("a well-formed stored resolution round-trips for provenance", () => {
    const atom = approveCheck(proposed(), "user-1");
    const withResolution: RuleCheck = { ...atom, requires: { ...atom.requires, resolved: forged } };
    const rows = parseRuleChecks([withResolution]);
    expect(rows[0]?.requires.resolved).toEqual(forged);
  });
});

describe("pathInCheckScope", () => {
  it("matches the scope itself and its descendants", () => {
    expect(pathInCheckScope("/packages/shared", "/packages/shared")).toBe(true);
    expect(pathInCheckScope("/packages/shared/src/x.ts", "/packages/shared")).toBe(true);
  });

  it("does not match an ancestor or a sibling", () => {
    // An edit to /packages is not an edit inside /packages/shared, and the command does
    // not verify it.
    expect(pathInCheckScope("/packages", "/packages/shared")).toBe(false);
    expect(pathInCheckScope("/packages/core/src/x.ts", "/packages/shared")).toBe(false);
    expect(pathInCheckScope("/packages/shared-utils/x.ts", "/packages/shared")).toBe(false);
  });

  it("treats / as the whole workspace", () => {
    expect(pathInCheckScope("/anything/at/all.ts", "/")).toBe(true);
  });
});

describe("the shared atom list holds both kinds", () => {
  const constraintAtom = {
    id: "con-1",
    mode: "forbid" as const,
    match: { kind: "regex" as const, pattern: "cursor:\\s*pointer", flags: "i" },
    message: "Use a real button.",
    authority: "human" as const,
    status: "active" as const,
    created_at: "2026-09-03T00:00:00.000Z",
    approved_by: "user-1",
  };

  it("round-trips a constraint and a check together, preserving order", () => {
    const check = approveCheck(proposed(), "user-1");
    const atoms = parseRuleAtoms([constraintAtom, check]);
    expect(atoms.map((a) => a.id)).toEqual(["con-1", "chk-1"]);
    expect(atoms.filter(isConstraintAtom)).toHaveLength(1);
    expect(atoms.filter(isCheckAtom)).toHaveLength(1);
  });

  it("does not lose the other kind on a read, which is how a write-back would delete it", () => {
    const check = approveCheck(proposed(), "user-1");
    // The per-kind parses each see only their own.
    expect(parseRuleChecks([constraintAtom, check]).map((c) => c.id)).toEqual(["chk-1"]);
    // The union parse sees both, and that is the one the backends use.
    expect(parseRuleAtoms([constraintAtom, check])).toHaveLength(2);
  });

  it("drops a malformed check rather than enforcing it", () => {
    const check = approveCheck(proposed(), "user-1");
    expect(parseRuleChecks([{ ...check, authority: "sudo" }])).toEqual([]);
    expect(parseRuleChecks([{ ...check, requires: { kind: "command", command: "x" } }])).toEqual([]);
    expect(parseRuleChecks([{ ...check, scope_path: 42 }])).toEqual([]);
    expect(parseRuleChecks("not json")).toEqual([]);
  });

  it("never promotes authority while parsing", () => {
    const [parsed] = parseRuleChecks([proposed()]);
    expect(parsed?.authority).toBe("inferred");
    expect(parsed?.status).toBe("proposed");
  });
});


it("Node builtin CHECK stays proposed until explicit human approval", () => {
  const input={...SHARED_CHECK,command:"node --test tests/highlight.test.mjs"},candidate=proposed(input);
  expect(candidate.status).toBe("proposed");expect(isCheckEnforceable(candidate)).toBe(false);expect(compileRuleChecks([candidate])).toBeNull();
  const approved=approveCheck(candidate,"user-1");expect(isCheckEnforceable(approved)).toBe(true);
  expect(compileRuleChecks([approved])).toMatchObject({command:input.command,fingerprint:"node:test[tests%2Fhighlight.test.mjs]#narrowed"});
  expect(validateCheckInput({...input,command:"node --test tests/highlight.test.mjs && true"})).toMatchObject({ok:false,code:"check_command_unfingerprintable"});
});
