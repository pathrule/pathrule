// SPDX-License-Identifier: Apache-2.0
/**
 * SELECTION atoms: source-backed PREFERENCES, in production (V31).
 *
 * A SELECTION says "under this context, prefer option A (optionally over B)". It is the operational
 * cousin of REMEDY and inherits REMEDY's two safety rules verbatim, because the failure mode is the
 * same: turning weak or mislabelled text into authority.
 *
 *  - A SELECTION is ADVISORY. It is never compiled, never enforced, never executed, and it NEVER
 *    becomes a CONSTRAINT. "Prefer X over Y" must not turn into "never use Y"; only an independent
 *    CONSTRAINT can forbid Y. Delivery states a preference, it never denies the alternative.
 *  - Human authority comes from an APPROVAL, never from the document the text sat in.
 *
 * The hard safety metric is FALSE_SELECTION = 0: a stored/delivered preference relationship must be
 * present in the source. An alternative is stored ONLY when the source names it; "prefer X here" with
 * no stated alternative yields a preference with NO alternative, never an invented "instead of Y".
 */
import { isAdvisoryAuthority, isTrustedAdvisoryAuthority, type AdvisoryAuthority } from "./grounded.js";

/**
 * How strongly the source asserts the preference, read off what the text SAYS. Only ESTABLISHED is
 * deliverable: a hedge ("might be better"), a one-off ("someone suggested"), or a superseded choice
 * ("we switched away from X") is stored so a person can see it, and never delivered as guidance.
 */
export type SelectionStrength = "ESTABLISHED" | "SPECULATIVE" | "SUPERSEDED";

export const SELECTION_STRENGTHS: readonly SelectionStrength[] = ["ESTABLISHED", "SPECULATIVE", "SUPERSEDED"];

/** The states that may become ACTIVE preference knowledge. Deliberately narrow, like REMEDY. */
export const DELIVERABLE_SELECTION_STRENGTHS: ReadonlySet<SelectionStrength> =
  new Set<SelectionStrength>(["ESTABLISHED"]);

/** Lifecycle. Same three words as REMEDY: a person declining a preference is a normal outcome. */
export type SelectionStatus = "proposed" | "active" | "rejected";

/** What the write path hands in. Authority, status and identity are derived. */
export interface SelectionInput {
  /** Verbatim context spans ("for server-side API calls"). Empty only when composed. */
  context_evidence: string[];
  /** The extractor's wording for the context. NEVER shown as source evidence. Null when evidence exists. */
  context_normalized: string | null;
  /** Verbatim preferred choice ("ServerClient"). At least one is required. */
  preferred_evidence: string[];
  /** Verbatim alternative(s) ("GeneratedClient"). Empty when the source names none. NEVER invented. */
  alternative_evidence: string[];
  strength: SelectionStrength;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

/** Stored shape. */
export interface SelectionAtom {
  id: string;
  kind: "selection";
  context_evidence: string[];
  context_normalized: string | null;
  preferred_evidence: string[];
  alternative_evidence: string[];
  strength: SelectionStrength;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: AdvisoryAuthority;
  status: SelectionStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type SelectionValidationCode =
  | "selection_no_preferred"
  | "selection_preferred_not_grounded"
  | "selection_alternative_not_grounded"
  | "selection_preferred_equals_alternative"
  | "selection_strength_unknown"
  | "selection_source_missing"
  | "selection_prohibition_as_preference"
  | "selection_mandatory_not_preference"
  | "selection_no_preference_language"
  | "selection_span_is_clause";

export type SelectionValidation =
  | { ok: true; value: SelectionInput }
  | { ok: false; code: SelectionValidationCode; message: string };

/** A person accepts the preference. Does not execute it, does not create a CONSTRAINT, does not raise strength. */
export function approveSelection(atom: SelectionAtom, approvedBy: string): SelectionAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}

/** Declining a preference. Persisted, so the same evidence does not return as a new proposal. */
export function rejectSelection(atom: SelectionAtom, rejectedBy: string): SelectionAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this reach an agent? A person approved it, it is active, and the source asserts it as established. */
export function isSelectionDeliverable(atom: SelectionAtom): boolean {
  return isTrustedAdvisoryAuthority(atom.authority) && atom.status === "active" && DELIVERABLE_SELECTION_STRENGTHS.has(atom.strength);
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/** Defensive parse of a stored payload. Malformed rows degrade to "skip this atom", never crash a read. */
export function parseSelectionAtom(raw: unknown): SelectionAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "selection") return null;
  const strength = o["strength"];
  if (typeof strength !== "string" || !SELECTION_STRENGTHS.includes(strength as SelectionStrength)) return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (!isAdvisoryAuthority(authority)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const preferred = asStringArray(o["preferred_evidence"]);
  if (preferred.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "selection",
    context_evidence: asStringArray(o["context_evidence"]),
    context_normalized: typeof o["context_normalized"] === "string" ? o["context_normalized"] : null,
    preferred_evidence: preferred,
    alternative_evidence: asStringArray(o["alternative_evidence"]),
    strength: strength as SelectionStrength,
    source: {
      kind: s["kind"], id: s["id"],
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
