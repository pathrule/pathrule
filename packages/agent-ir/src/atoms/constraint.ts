// SPDX-License-Identifier: Apache-2.0
/**
 * Executable CONSTRAINT atoms: the one piece of knowledge that leaves prose and
 * becomes deterministic runtime behaviour.
 *
 * Three properties matter more
 * than the code:
 *
 *  1. AUTHORING CANNOT CLAIM AUTHORITY. `ConstraintInput` (what a surface accepts)
 *     carries no authority/status. Those are stamped here, and every write through
 *     the normal knowledge path lands `inferred` + `proposed`, which never compiles
 *     to anything enforceable. Fail-closed: the absence of an agent marker is not
 *     evidence of a human (see `resolveClientId()` returning null on an unrecognised
 *     client name), so a human is only ever recognised by an explicit approval.
 *
 *  2. ONE COMPILER, IN TS. The compiled form is stored data, so both hook-index
 *     builders (cloud SQL, local TS) merely carry it. `semantic_tags` already has two
 *     implementations that disagree; that is tolerable for ranking and not tolerable
 *     for a deny, because a rule that blocks in one edition and not the other is an
 *     indicator that cannot separate two cases with opposite fixes.
 *
 *  3. VALIDATED IN THE LANGUAGE THAT RUNS IT. The pattern is compiled with JS
 *     `new RegExp`, because the runtime that tests it is `pathrule-hook.js`. Postgres
 *     regex is a different language; validating there and running here is a drift
 *     source, and the legacy `pathrule_internal.extract_block_pattern` does exactly
 *     that. Nothing in this module goes through it.
 */

import type { RuleConstraint } from "@pathrule/protocol/rule-atoms.js";

// The stored shape is part of the open format contract (@pathrule/protocol).
export type { ConstraintAuthority, ConstraintStatus, RuleConstraint } from "@pathrule/protocol/rule-atoms.js";

/** Authored shape. Everything else about a constraint is derived, never claimed. */
export interface ConstraintInput {
  /** Only `forbid` exists today. The field is present so `require` needs no schema change. */
  mode: "forbid";
  /** Regex source, in JS syntax. */
  pattern: string;
  /** Subset of `i` / `m` / `s`. See `ALLOWED_FLAGS` for why `g` is refused. */
  flags?: string;
  /** What the author wants done instead. Carried into the deny reason. */
  message: string;
}

/** What `compileRuleConstraints` projects onto the hook-index rule stub. */
export interface CompiledConstraint {
  enforcement: "strict";
  /** Absent on a path-only constraint. */
  block_pattern?: { source: string; flags: string; message: string };
  /** Absent on a content-only constraint. */
  block_path?: { scope_path: string; file_extensions?: string[]; message: string };
}

export type ConstraintValidationCode =
  | "constraint_mode_unsupported"
  | "constraint_pattern_too_short"
  | "constraint_pattern_too_long"
  | "constraint_flags_unsupported"
  | "constraint_pattern_uncompilable"
  | "constraint_pattern_matches_empty"
  | "constraint_message_too_short";

export type ConstraintValidation =
  | { ok: true; value: Required<ConstraintInput> }
  | { ok: false; code: ConstraintValidationCode; message: string };

/**
 * `g` and `y` are refused because `RegExp.prototype.test` advances `lastIndex` on a
 * sticky/global regex, so the same edit alternates between denied and allowed. A gate
 * that answers differently on identical input is worse than no gate.
 */
const ALLOWED_FLAGS = new Set(["i", "m", "s"]);
const MIN_PATTERN_CHARS = 3;
const MAX_PATTERN_CHARS = 200;
const MIN_MESSAGE_CHARS = 10;

/**
 * Every check that can be made at write time, when a human is present to read the
 * error. Deliberately does NOT attempt ReDoS analysis or "does this match anything in
 * the repo": the first needs a solver, the second needs a scan, and neither is the
 * reason 0 of 1042 rules ever carried a pattern.
 */
export function validateConstraintInput(input: ConstraintInput): ConstraintValidation {
  if (input.mode !== "forbid") {
    return {
      ok: false,
      code: "constraint_mode_unsupported",
      message: `Only mode "forbid" is supported (got "${String(input.mode)}").`,
    };
  }

  const pattern = input.pattern ?? "";
  if (pattern.length < MIN_PATTERN_CHARS) {
    return {
      ok: false,
      code: "constraint_pattern_too_short",
      message: `A forbid pattern needs at least ${MIN_PATTERN_CHARS} characters (got ${pattern.length}).`,
    };
  }
  if (pattern.length > MAX_PATTERN_CHARS) {
    return {
      ok: false,
      code: "constraint_pattern_too_long",
      message: `A forbid pattern is capped at ${MAX_PATTERN_CHARS} characters (got ${pattern.length}).`,
    };
  }

  const flags = input.flags ?? "";
  const seen = new Set<string>();
  for (const f of flags) {
    if (!ALLOWED_FLAGS.has(f) || seen.has(f)) {
      return {
        ok: false,
        code: "constraint_flags_unsupported",
        message: `Flags must be a unique subset of "ims" (got "${flags}"). "g" and "y" make .test() stateful.`,
      };
    }
    seen.add(f);
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    return {
      ok: false,
      code: "constraint_pattern_uncompilable",
      message: `Pattern does not compile as a JavaScript regex: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A pattern that matches the empty string matches every edit, so it would deny all
  // work with no way for the agent to comply.
  if (re.test("")) {
    return {
      ok: false,
      code: "constraint_pattern_matches_empty",
      message: "Pattern matches the empty string, so it would deny every edit.",
    };
  }

  const message = (input.message ?? "").trim();
  if (message.length < MIN_MESSAGE_CHARS) {
    return {
      ok: false,
      code: "constraint_message_too_short",
      message: `A constraint needs a remedy message of at least ${MIN_MESSAGE_CHARS} characters; a bare denial leaves the agent stuck.`,
    };
  }

  return { ok: true, value: { mode: "forbid", pattern, flags, message } };
}

/**
 * Stamp a validated input as a stored atom. Always `inferred` + `proposed`: this is
 * the only entry point from the knowledge-write path, and that path cannot tell an
 * agent from a person.
 */
export function stampProposedConstraint(
  value: Required<ConstraintInput>,
  opts: { id: string; now: string },
): RuleConstraint {
  return {
    id: opts.id,
    mode: "forbid",
    match: { kind: "regex", pattern: value.pattern, flags: value.flags },
    message: value.message,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
  };
}

/**
 * Stamp a compiler-verified representation as a PROPOSAL.
 *
 * Verification and activation stay separate on purpose. This function records that the
 * REPRESENTATION is sound; whether the POLICY may auto-activate is a different fact, held
 * by the caller, and `activateVerifiedConstraint` is the only thing that acts on it.
 */
export function stampVerifiedConstraint(
  rep: {
    pattern?: string;
    flags: string;
    message: string;
    path?: { scope_path: string; file_extensions?: string[] };
    /** The prose the oracles ran against. Stored so the pair can be re-proved later. */
    source_text?: string;
  },
  opts: { id: string; now: string },
): RuleConstraint {
  const source = (rep.source_text ?? "").trim();
  return {
    id: opts.id,
    mode: "forbid",
    ...(rep.pattern ? { match: { kind: "regex" as const, pattern: rep.pattern, flags: rep.flags } } : {}),
    ...(rep.path ? { path: rep.path } : {}),
    message: rep.message,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
    ...(source ? { grounding: { source_text: source } } : {}),
  };
}

/** The only transition that grants enforcement authority. */
export function approveConstraint(constraint: RuleConstraint, approvedBy: string): RuleConstraint {
  return { ...constraint, authority: "human", status: "active", approved_by: approvedBy };
}

/**
 * Two independent checks, on purpose: a bug that flips `status` alone must not be able
 * to grant enforcement.
 *
 * Deliberately says nothing about grounding: this answers "was this atom ever armed",
 * which is a property of the atom alone. Whether the arming still HOLDS is
 * `isGroundedIn`, and only the compile boundary is in a position to ask it, because only
 * there is the current rule body in hand.
 */
export function isEnforceable(constraint: RuleConstraint): boolean {
  const trusted = constraint.authority === "human" || constraint.authority === "verified";
  return trusted && constraint.status === "active";
}

/**
 * Is a COMPILER-VERIFIED atom still supported by the prose it was proved against?
 *
 * This is the invariant that makes CONSTRAINT safe under mutation paths nobody audited.
 * A `verified` atom's authority came from a machine proving a PAIR — this representation,
 * that prose — and the proof is only as current as the prose. Rule bodies are rewritten
 * from several places today (the MCP update handler, the console editor, the VS Code
 * virtual filesystem, the maintenance proposal applier and its rollback builder), and adding an invalidation hook to each is a list that goes
 * stale the moment someone adds a sixth. Re-proving at the single gate every one of them
 * feeds into does not.
 *
 * Two deliberate limits:
 *
 *  - `human` and `inferred` authority are untouched. A person's approval was never a
 *    claim about this prose, so revoking it on a prose edit would be inventing a policy;
 *    `inferred` is not enforceable in the first place.
 *  - The check is CONTAINMENT of the exact source excerpt, not meaning. A rewrite that
 *    keeps the sentence and reverses it elsewhere in the body still passes, and no
 *    string comparison can see that. What this closes is the whole class where the
 *    grounding text is gone and the atom kept firing anyway.
 *
 * Fail-safe by construction: a `verified` atom with no stored grounding cannot be
 * re-proved, so it does not compile. A constraint that stops enforcing is a visible,
 * recoverable failure; one that enforces a ban the rule no longer states is neither.
 */
export function isGroundedIn(constraint: RuleConstraint, ruleContent: string | null | undefined): boolean {
  if (constraint.authority !== "verified") return true;
  const source = constraint.grounding?.source_text;
  if (!source) return false;
  return (ruleContent ?? "").includes(source);
}

/**
 * Activate an atom whose representation the deterministic compiler verified.
 *
 * The second writer of `status: "active"`, alongside `approveConstraint`. It grants
 * enforcement WITHOUT a human approval, and it is safe to do so only because the
 * representation was built mechanically from a grounded literal and both oracles passed.
 * `approved_by` stays null on purpose: nobody approved this, a machine proved it, and
 * recording a person there would be the same conflation this enum split exists to end.
 */
export function activateVerifiedConstraint(constraint: RuleConstraint): RuleConstraint {
  return { ...constraint, authority: "verified", status: "active", approved_by: null };
}

/**
 * Deterministic projection onto the hook-index rule stub's existing document-level
 * fields. No LLM, no I/O, no randomness. Returns null when the rule has nothing
 * enforceable, which is byte-identical to today's behaviour for every existing rule.
 *
 * Slice 1 compiles at most one constraint per rule: `RuleStub.block_pattern` is
 * singular, and unioning patterns would lose the per-constraint remedy message.
 */
export function compileRuleConstraints(
  // `readonly unknown[]`, not the atom union: constraint.ts must not import atoms.ts,
  // which imports this file. The narrowing below is the type guard either way.
  constraints: readonly unknown[] | null | undefined,
  /**
   * The rule body AS STORED RIGHT NOW. Required, not optional: a caller that has a rule
   * has its content, and a default would let a new call site silently opt out of the
   * grounding gate — the exact failure this parameter exists to prevent.
   */
  ruleContent: string | null | undefined,
): CompiledConstraint | null {
  if (!constraints || constraints.length === 0) return null;
  // Grounding is part of the SELECTION predicate, not a filter applied to the winner.
  // Put it after the find and a stale atom would shadow a live one behind it, turning a
  // rule that should still enforce into one that does not.
  const enforceable = constraints.find(
    (c): c is RuleConstraint =>
      (c as RuleConstraint).mode === "forbid" &&
      isEnforceable(c as RuleConstraint) &&
      isGroundedIn(c as RuleConstraint, ruleContent),
  );
  if (!enforceable) return null;
  // Path-only: no pattern to re-validate, so the path half is the whole projection.
  if (!enforceable.match) {
    if (!enforceable.path || !enforceable.path.scope_path) return null;
    return {
      enforcement: "strict",
      block_path: { ...enforceable.path, message: enforceable.message },
    };
  }
  // Re-validated here rather than trusted: stored data can predate a validation rule,
  // and a pattern that no longer compiles must degrade to "not enforced" rather than
  // throwing inside an index build.
  const check = validateConstraintInput({
    mode: "forbid",
    pattern: enforceable.match.pattern,
    flags: enforceable.match.flags,
    message: enforceable.message,
  });
  if (!check.ok) return null;
  return {
    enforcement: "strict",
    block_pattern: {
      source: enforceable.match.pattern,
      flags: enforceable.match.flags,
      message: enforceable.message,
    },
    ...(enforceable.path
      ? { block_path: { ...enforceable.path, message: enforceable.message } }
      : {}),
  };
}

/**
 * Defensive read of the `constraints` column. Anything malformed is dropped rather
 * than repaired: a half-understood constraint must never become an enforced one.
 */
export function parseRuleConstraints(raw: unknown): RuleConstraint[] {
  const rows = Array.isArray(raw) ? raw : typeof raw === "string" ? safeJsonArray(raw) : [];
  const out: RuleConstraint[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const match = r["match"] as Record<string, unknown> | undefined;
    if (r["mode"] !== "forbid") continue;
    if (typeof r["id"] !== "string" || typeof r["message"] !== "string") continue;
    const authority = r["authority"];
    const status = r["status"];
    if (authority !== "human" && authority !== "verified" && authority !== "inferred") continue;
    if (status !== "active" && status !== "proposed") continue;
    // A content pattern, a path narrowing, or both. An atom with neither forbids nothing
    // and is dropped rather than repaired.
    const hasMatch = Boolean(match && match["kind"] === "regex" && typeof match["pattern"] === "string");
    const path = parsePathNarrowing(r["path"]);
    if (!hasMatch && !path) continue;
    const grounding = parseGrounding(r["grounding"]);
    out.push({
      id: r["id"],
      mode: "forbid",
      ...(hasMatch
        ? {
            match: {
              kind: "regex" as const,
              pattern: match!["pattern"] as string,
              flags: typeof match!["flags"] === "string" ? (match!["flags"] as string) : "",
            },
          }
        : {}),
      ...(path ? { path } : {}),
      message: r["message"],
      authority,
      status,
      created_at: typeof r["created_at"] === "string" ? r["created_at"] : "",
      approved_by: typeof r["approved_by"] === "string" ? r["approved_by"] : null,
      // Dropped rather than repaired, like everything else here. Losing it costs a
      // `verified` atom its enforcement, which is the safe direction; inventing one
      // would hand it enforcement it cannot prove.
      ...(grounding ? { grounding } : {}),
    });
  }
  return out;
}

/** Defensive read of the stored grounding key. Anything malformed is dropped. */
function parseGrounding(raw: unknown): RuleConstraint["grounding"] {
  if (!raw || typeof raw !== "object") return undefined;
  const source = (raw as Record<string, unknown>)["source_text"];
  if (typeof source !== "string" || source.trim().length === 0) return undefined;
  return { source_text: source };
}

/** Defensive read of a stored path narrowing. Anything malformed is dropped. */
function parsePathNarrowing(raw: unknown): RuleConstraint["path"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const scope = r["scope_path"];
  if (typeof scope !== "string" || !scope.startsWith("/") || scope.includes("..")) return undefined;
  const raw_ext = r["file_extensions"];
  if (raw_ext === undefined) return { scope_path: scope };
  if (!Array.isArray(raw_ext)) return undefined;
  const exts = raw_ext.filter((x): x is string => typeof x === "string" && /^\.[a-zA-Z0-9]{1,12}$/.test(x));
  return exts.length > 0 ? { scope_path: scope, file_extensions: exts } : { scope_path: scope };
}

function safeJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
