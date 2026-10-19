// SPDX-License-Identifier: Apache-2.0
/**
 * REMEDY atoms: conditional corrective knowledge, in production.
 *
 * The semantics here are the ones frozen as `REMEDY_PRIMITIVE_V1` after eight measured
 * generations of research. Nothing in this file may relax them, and the two that carry the
 * safety of the whole primitive are:
 *
 *  - Only three evidence states are DELIVERABLE. A fix that was merely attempted, hedged,
 *    reverted or superseded is stored and never delivered. Turning weak historical evidence
 *    into authority is the failure the primitive exists to prevent.
 *  - Authority comes from an APPROVAL or from a PROOF (`grounded.ts`: every delivered span is
 *    still verbatim in the source), never from the kind of document the text sat in. That was
 *    learned by breaking it: reading "this came from a rule" as standing guidance let two
 *    mislabelled prohibitions be delivered as advice.
 *
 * A REMEDY is ADVISORY. It is never compiled, never enforced, and never executed. It does not
 * outrank a CONSTRAINT. This file therefore has no compiler and no hook-index projection, which
 * is the main thing that makes it shorter than `constraint.ts` and `check.ts`.
 */
import { isAdvisoryAuthority, isTrustedAdvisoryAuthority, type AdvisoryAuthority } from "./grounded.js";

/**
 * How much the source is claiming, read off what the text SAYS rather than what seems likely.
 *
 * Measured and worth keeping in mind when reading these: on the frozen eval every confusion the
 * model made was WITHIN a tier (observed versus repeated, speculative versus attempted) and
 * never across the weak/strong boundary, which is the only boundary delivery acts on.
 */
export type RemedyEvidenceState =
  | "HUMAN_AUTHORED"
  | "REPEATED_SUCCESS"
  | "OBSERVED_SUCCESS"
  | "SPECULATIVE"
  | "ATTEMPTED"
  | "FAILED"
  | "SUPERSEDED";

export const REMEDY_EVIDENCE_STATES: readonly RemedyEvidenceState[] = [
  "HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS",
  "SPECULATIVE", "ATTEMPTED", "FAILED", "SUPERSEDED",
];

/**
 * The states that may become ACTIVE corrective knowledge. Deliberately narrow.
 * Anything outside this set is stored `proposed` so a person can still see it, and is never
 * delivered.
 */
export const DELIVERABLE_EVIDENCE_STATES: ReadonlySet<RemedyEvidenceState> =
  new Set<RemedyEvidenceState>(["HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS"]);

/**
 * Which kind of condition the remedy hangs off, kept apart because independent readers separate
 * them perfectly (24 of 24) and because their conditions differ in KIND:
 *  - `bind`: the condition is a standing rule ("never use X; use Y instead")
 *  - `trouble`: the condition is something that actually went wrong
 */
export type RemedyVariant = "bind" | "trouble";

/**
 * Lifecycle. `proposed` and `active` are the same two words the constraint atoms already use,
 * so the runtime gate keeps its meaning. `rejected` is added because a REMEDY is advisory and a
 * person declining one is a normal outcome that has to persist; a constraint has no equivalent.
 */
export type RemedyStatus = "proposed" | "active" | "rejected";

/** What the surrounding pipeline hands in. Authority, status and identity are derived. */
export interface RemedyInput {
  variant: RemedyVariant;
  /** Verbatim from the source. Empty only when the condition had to be composed. */
  condition_evidence: string[];
  /** The extractor's wording. NEVER presented as source evidence. Null when evidence exists. */
  condition_normalized: string | null;
  /** Verbatim from the source. At least one is required. */
  action_evidence: string[];
  evidence_state: RemedyEvidenceState;
  /** Where it came from, so a reviewer can go and look. */
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  /** When the corrective knowledge was observed, not when the row was written. */
  observed_at: string;
}

/** Stored shape. */
export interface RemedyAtom {
  id: string;
  kind: "remedy";
  variant: RemedyVariant;
  condition_evidence: string[];
  condition_normalized: string | null;
  action_evidence: string[];
  evidence_state: RemedyEvidenceState;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  /**
   * `verified` is unreachable by construction: in this codebase it means the deterministic
   * COMPILER proved a representation, and nothing about a remedy is compiler-provable.
   * `grounded` proves only that its spans are verbatim in the source (`grounded.ts`).
   */
  authority: AdvisoryAuthority;
  status: RemedyStatus;
  created_at: string;
  approved_by: string | null;
  /** Deterministic identity over the evidence. Same evidence, same atom, forever. */
  fingerprint: string;
}

export type RemedyValidationCode =
  | "remedy_no_action_evidence"
  | "remedy_action_not_grounded"
  | "remedy_no_condition"
  | "remedy_condition_not_grounded"
  | "remedy_bind_condition_not_prohibitory"
  | "remedy_bind_action_restates_condition"
  | "remedy_evidence_state_unknown"
  | "remedy_source_missing";

export type RemedyValidation =
  | { ok: true; value: RemedyInput }
  | { ok: false; code: RemedyValidationCode; message: string };

/**
 * The only transition that makes a remedy reusable knowledge.
 *
 * It does NOT execute the remedy, does not convert it to a CONSTRAINT or a CHECK, does not
 * touch its evidence or provenance, and does not raise its evidence state. It records that a
 * person accepted the condition-to-action relationship.
 */
export function approveRemedy(atom: RemedyAtom, approvedBy: string): RemedyAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}

/** Declining a remedy. Persisted, so the same evidence does not come back as a new proposal. */
export function rejectRemedy(atom: RemedyAtom, rejectedBy: string): RemedyAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/**
 * Would this reach an agent? Three independent conditions, so one flipped field cannot grant
 * delivery: a person approved it or its grounding was proved, it is active, and the source
 * actually claimed success. The grounding itself is re-proved at the delivery gate.
 */
export function isRemedyDeliverable(atom: RemedyAtom): boolean {
  return (
    isTrustedAdvisoryAuthority(atom.authority) &&
    atom.status === "active" &&
    DELIVERABLE_EVIDENCE_STATES.has(atom.evidence_state)
  );
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/**
 * Defensive parse of a stored payload. Malformed rows must fail cleanly and never crash a read:
 * a row written by a newer version, or half-written by a crash, has to degrade to "skip this
 * atom" rather than "the workspace will not open".
 */
export function parseRemedyAtom(raw: unknown): RemedyAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "remedy") return null;
  const variant = o["variant"];
  if (variant !== "bind" && variant !== "trouble") return null;
  const state = o["evidence_state"];
  if (typeof state !== "string" || !REMEDY_EVIDENCE_STATES.includes(state as RemedyEvidenceState)) return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (!isAdvisoryAuthority(authority)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const actions = asStringArray(o["action_evidence"]);
  if (actions.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "remedy", variant,
    condition_evidence: asStringArray(o["condition_evidence"]),
    condition_normalized: typeof o["condition_normalized"] === "string" ? o["condition_normalized"] : null,
    action_evidence: actions,
    evidence_state: state as RemedyEvidenceState,
    source: {
      kind: s["kind"],
      id: s["id"],
      title: typeof s["title"] === "string" ? s["title"] : "",
      node_path: typeof s["node_path"] === "string" ? s["node_path"] : null,
    },
    observed_at: typeof o["observed_at"] === "string" ? o["observed_at"] : "",
    authority, status,
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
    approved_by: typeof o["approved_by"] === "string" ? o["approved_by"] : null,
    fingerprint,
  };
}

/** Order-preserving parse of a stored list, skipping anything malformed. */
export function parseRemedyAtoms(raw: unknown): RemedyAtom[] {
  if (typeof raw === "string") {
    try { return parseRemedyAtoms(JSON.parse(raw)); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(parseRemedyAtom).filter((a): a is RemedyAtom => a !== null);
}
