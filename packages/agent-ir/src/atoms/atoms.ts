// SPDX-License-Identifier: Apache-2.0
/**
 * The atom list stored on a rule (`rules.constraints`, jsonb).
 *
 * Two kinds live in one list, discriminated by `kind`. Constraint atoms predate the
 * field and carry no `kind`, so an ABSENT kind means constraint. That keeps every stored
 * row readable without a migration and is why `kind` is optional on the constraint side
 * rather than backfilled.
 *
 * One parse for the whole list, on purpose. A per-kind parse that each backend called
 * separately would drop the other kind's atoms on read, and the next write of the list
 * would delete them.
 */

import { parseRuleConstraints } from "./constraint.js";
import { parseRuleChecks } from "./check.js";
import type { RuleAtom, RuleCheck, RuleConstraint } from "@pathrule/protocol/rule-atoms.js";

// The atom list's type is part of the open format contract (@pathrule/protocol).
export type { RuleAtom } from "@pathrule/protocol/rule-atoms.js";

/** True when the atom is a constraint (absent `kind` included). */
export function isConstraintAtom(atom: RuleAtom): atom is RuleConstraint {
  return (atom as RuleCheck).kind !== "check";
}

/** True when the atom is a check. */
export function isCheckAtom(atom: RuleAtom): atom is RuleCheck {
  return (atom as RuleCheck).kind === "check";
}

/**
 * Parse the stored list, preserving both kinds and their original order.
 *
 * Order matters: a write path that reads, appends and writes back must not reshuffle
 * atoms, or two clients editing different atoms produce spurious diffs in
 * `content_history`.
 */
export function parseRuleAtoms(raw: unknown): RuleAtom[] {
  const rows = Array.isArray(raw) ? raw : typeof raw === "string" ? safeJsonArray(raw) : [];
  const constraints = new Map(parseRuleConstraints(rows).map((c) => [c.id, c] as const));
  const checks = new Map(parseRuleChecks(rows).map((c) => [c.id, c] as const));
  const out: RuleAtom[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = (row as Record<string, unknown>)["id"];
    if (typeof id !== "string") continue;
    const atom = checks.get(id) ?? constraints.get(id);
    if (atom) out.push(atom);
  }
  return out;
}

function safeJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
