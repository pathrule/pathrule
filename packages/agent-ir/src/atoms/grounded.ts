// SPDX-License-Identifier: Apache-2.0
/**
 * GROUNDED authority: advisory knowledge that is active without a person's approval, because a
 * machine proved every word it delivers is still in its source (owner decision 2026-10-15).
 *
 * The advisory kinds (REMEDY, SELECTION, PROCEDURE, CONTEXT, RATIONALE) never block, compile or
 * execute anything. A grounded atom therefore carries no more risk than delivering its source
 * memory's own text, which Foundation already does, as long as two things hold:
 *
 *  - it delivers only VERBATIM source text: every `*_normalized` paraphrase is null, and a CONTEXT
 *    atom carries no free-text topic, so no word reaches the agent that the source did not say;
 *  - that text is STILL in the source at delivery time. Like a `verified` CONSTRAINT
 *    (`isGroundedIn`), the proof is re-run at the single delivery gate instead of trusting every
 *    edit path to invalidate the atom. A source rewritten without the evidence silences the atom;
 *    restoring the text brings it back.
 *
 * What this does NOT grant: enforcement. CONSTRAINT and CHECK stay `human` or `verified` only, and
 * PRECEDENCE (which decides conflicts) stays human-approved. A person's approval or rejection still
 * outranks a grounded activation, and a rejection is never undone by one.
 */
import type { RemedyAtom } from "./remedy.js";
import type { SelectionAtom } from "./selection.js";
import type { ProcedureAtom } from "./procedure.js";
import type { ContextAtom } from "./context.js";
import type { RationaleAtom } from "./rationale.js";

/** Who stands behind an advisory atom. `inferred` is never delivered. */
export type AdvisoryAuthority = "human" | "grounded" | "inferred";

export function isAdvisoryAuthority(value: unknown): value is AdvisoryAuthority {
  return value === "human" || value === "grounded" || value === "inferred";
}

/** May an atom with this authority reach an agent (the other lifecycle checks still apply)? */
export function isTrustedAdvisoryAuthority(authority: AdvisoryAuthority): boolean {
  return authority === "human" || authority === "grounded";
}

export type GroundableAtom = RemedyAtom | SelectionAtom | ProcedureAtom | ContextAtom | RationaleAtom;

/**
 * Every span the atom would put in front of an agent, or null when the atom carries text the
 * source did not say (a paraphrase or a free-text topic) and so can never be grounded.
 */
export function deliveredSpans(atom: GroundableAtom): string[] | null {
  switch (atom.kind) {
    case "remedy":
      return atom.condition_normalized === null ? [...atom.condition_evidence, ...atom.action_evidence] : null;
    case "selection":
      return atom.context_normalized === null ? [...atom.context_evidence, ...atom.preferred_evidence, ...atom.alternative_evidence] : null;
    case "procedure":
      return atom.operation_normalized === null ? [...atom.operation_evidence, ...atom.steps] : null;
    case "context":
      return atom.fact_normalized === null && atom.topic === null ? [...atom.fact_evidence] : null;
    case "rationale":
      return atom.subject_normalized === null ? [...atom.subject_evidence, ...atom.reason_evidence] : null;
  }
}

/**
 * Is every delivered span of this atom contained, verbatim, in `sourceText`? Containment, not
 * meaning: it closes the class where the grounding text is gone and the atom kept firing.
 */
export function spansGroundedIn(atom: GroundableAtom, sourceText: string | null | undefined): boolean {
  const spans = deliveredSpans(atom);
  if (!spans || spans.length === 0 || !sourceText) return false;
  return spans.every((span) => span.trim().length > 0 && sourceText.includes(span));
}

/**
 * The delivery gate. A human-approved atom is untouched (an approval was never a claim about the
 * current prose); a grounded one must still be proved against its source's current text.
 */
export function groundingHolds(atom: GroundableAtom, sourceText: string | null | undefined): boolean {
  return atom.authority !== "grounded" || spansGroundedIn(atom, sourceText);
}

/** Activate an atom whose spans were just proved against its source. `approved_by` stays null: nobody approved it. */
export function activateGrounded<T extends GroundableAtom>(atom: T): T {
  return { ...atom, authority: "grounded", status: "active", approved_by: null };
}
