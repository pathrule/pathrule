// SPDX-License-Identifier: Apache-2.0
/**
 * The stored shapes of the rule atoms (`rules.constraints`, jsonb): what a CONSTRAINT and a CHECK
 * look like on disk and on the wire. Types only, so every client, backend and the hook-index
 * contract can name them. Authoring, compiling and delivering them is @pathrule/agent-ir.
 */

/**
 * Who or what makes this atom's representation trustworthy.
 *
 * `human`   an explicit approval happened (the original path, unchanged)
 * `verified` the deterministic compiler built the representation and both oracles passed
 * `inferred` neither: a proposal, never enforceable
 *
 * `verified` exists because model confidence is not authority and deterministic
 * verification is: an approval whose only job
 * is to re-check something a machine already proved is friction, not safety.
 */
export type ConstraintAuthority = "human" | "verified" | "inferred";
export type ConstraintStatus = "active" | "proposed";

/** Stored shape (`rules.constraints`). */
export interface RuleConstraint {
  id: string;
  /**
   * Absent on every constraint written before CHECK existed, so absence means
   * "constraint". Never backfilled: a migration to add a field whose absence already
   * carries the right meaning would only create a window where it means neither.
   */
  kind?: "constraint";
  mode: "forbid";
  /**
   * The content pattern. ABSENT on a path-only constraint, whose subject is where a file
   * is rather than what it contains. Measured need: one real rule forbids `.md` files
   * under a subtree, and forcing that into a content regex is the wrong target.
   */
  match?: { kind: "regex"; pattern: string; flags: string };
  /**
   * Optional path narrowing. Exact or descendant, plus an extension filter. Present with
   * `match` it is an AND; present alone it is the whole predicate.
   */
  path?: { scope_path: string; file_extensions?: string[] };
  message: string;
  authority: ConstraintAuthority;
  status: ConstraintStatus;
  created_at: string;
  /** `auth.users.id` of the approver. Only ever set by `approveConstraint`. */
  approved_by: string | null;
  /**
   * What a COMPILER-VERIFIED representation was proved against. Present only on an atom
   * whose authority is `verified`, because that is the only authority derived from the
   * prose rather than from a person.
   *
   * This is the whole reason a `verified` atom can be re-checked later. See
   * `isGroundedIn`: the compile boundary re-proves the pair rather than trusting that
   * the body has not moved since, which is what makes the invariant hold no matter which
   * mutation path rewrote it.
   */
  grounding?: { source_text: string };
}

export type ResolutionStatus = "resolved" | "unresolved" | "non_terminating";

export interface ResolvedCommand {
  status: ResolutionStatus;
  /**
   * The concrete command the chain ends in, when there is exactly one.
   * null for a recursive invocation (many) or when unresolved.
   */
  runs: string | null;
  /**
   * The script chain that was walked, most general first, e.g.
   * ["pnpm --filter @pathrule/app test:watch", "@pathrule/app:test:watch = vitest"].
   * Read by a human at approval time; never parsed.
   */
  chain: string[];
  /** Why the status is what it is. Always set for unresolved and non_terminating. */
  reason: string | null;
}

/** Stored shape, in the same atom list as constraints, discriminated by `kind`. */
export interface RuleCheck {
  id: string;
  kind: "check";
  scope_path: string;
  requires: {
    kind: "command";
    command: string;
    /**
     * Canonical form from `classifyVerificationCommand`, computed at authoring time and
     * STORED. The cloud index builder is SQL and cannot run the classifier, so the
     * compiled identity has to be data, exactly as it is for a constraint's pattern.
     */
     fingerprint: string;
    /**
     * What the command was determined to actually run, when the authoring surface could
     * read the repo. Optional and additive: a surface with no filesystem (the remote MCP
     * in Pathrule Cloud) stores nothing here, and every atom written before this existed has no
     * field at all.
     *
     * For validation, approval visibility and provenance ONLY. Runtime evidence matching
     * stays on `fingerprint`; nothing reads this at runtime.
     */
    resolved?: ResolvedCommand;
  };
  message: string;
  authority: ConstraintAuthority;
  status: ConstraintStatus;
  created_at: string;
  approved_by: string | null;
}

/** Two kinds live in one list, discriminated by `kind`; an absent kind means constraint. */
export type RuleAtom = RuleConstraint | RuleCheck;
