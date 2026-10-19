// SPDX-License-Identifier: Apache-2.0
/**
 * CONTEXT atoms: source-backed descriptive FACTS, in production (V32).
 *
 * A CONTEXT tells an agent something true about the code it is working in ("the API package is
 * generated from the OpenAPI schema"). It is descriptive, never normative, and it must NEVER become
 * enforcement.
 *
 * The V31 lesson is applied from the start: FALSE_CONTEXT is SEMANTIC, not grounding. A grounded span
 * that is actually a preference, a prohibition, a requirement, an instruction, or a rationale is a
 * FALSE_CONTEXT even though its words are in the source. The deterministic gates below keep a CONTEXT
 * a plain descriptive fact, and keep a stale/speculative fact from being delivered as a current one.
 * Hard target: FALSE_CONTEXT = 0. Prefer abstention.
 */
import { isAdvisoryAuthority, isTrustedAdvisoryAuthority, type AdvisoryAuthority } from "./grounded.js";

/**
 * The epistemic status of the fact, read off what the source says. Only CURRENT is deliverable: a
 * fact the source frames as past ("we used X in 2023"), replaced ("switched away"), or speculative
 * ("might be") is stored so a person can see it, and never delivered as present truth.
 */
export type ContextTemporalStatus = "CURRENT" | "HISTORICAL" | "SUPERSEDED" | "SPECULATIVE";
export const CONTEXT_TEMPORAL_STATUSES: readonly ContextTemporalStatus[] = ["CURRENT", "HISTORICAL", "SUPERSEDED", "SPECULATIVE"];
export const DELIVERABLE_CONTEXT_STATUSES: ReadonlySet<ContextTemporalStatus> = new Set<ContextTemporalStatus>(["CURRENT"]);

export type ContextStatus = "proposed" | "active" | "rejected";

export interface ContextInput {
  /** Verbatim fact span(s). At least one is required. */
  fact_evidence: string[];
  /** The extractor's wording. NEVER shown as source evidence. Null when evidence exists. */
  fact_normalized: string | null;
  /** Optional topic/subject the fact is about ("build", "auth"), for relevance. Verbatim or null. */
  topic: string | null;
  temporal_status: ContextTemporalStatus;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

export interface ContextAtom {
  id: string;
  kind: "context";
  fact_evidence: string[];
  fact_normalized: string | null;
  topic: string | null;
  temporal_status: ContextTemporalStatus;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: AdvisoryAuthority;
  status: ContextStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type ContextValidationCode =
  | "context_no_fact"
  | "context_fact_not_grounded"
  | "context_status_unknown"
  | "context_source_missing"
  | "context_is_preference"
  | "context_is_prohibition"
  | "context_is_mandatory"
  | "context_is_instruction"
  | "context_is_rationale"
  | "context_stale_marked_current";

export type ContextValidation =
  | { ok: true; value: ContextInput }
  | { ok: false; code: ContextValidationCode; message: string };

export function approveContext(atom: ContextAtom, approvedBy: string): ContextAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}
export function rejectContext(atom: ContextAtom, rejectedBy: string): ContextAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this reach an agent? A person approved it, it is active, and the source frames it as CURRENT. */
export function isContextDeliverable(atom: ContextAtom): boolean {
  return isTrustedAdvisoryAuthority(atom.authority) && atom.status === "active" && DELIVERABLE_CONTEXT_STATUSES.has(atom.temporal_status);
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export function parseContextAtom(raw: unknown): ContextAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "context") return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (!isAdvisoryAuthority(authority)) return null;
  const temporal = o["temporal_status"];
  if (typeof temporal !== "string" || !CONTEXT_TEMPORAL_STATUSES.includes(temporal as ContextTemporalStatus)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const facts = asStringArray(o["fact_evidence"]);
  if (facts.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "context", fact_evidence: facts,
    fact_normalized: typeof o["fact_normalized"] === "string" ? o["fact_normalized"] : null,
    topic: typeof o["topic"] === "string" ? o["topic"] : null,
    temporal_status: temporal as ContextTemporalStatus,
    source: { kind: s["kind"], id: s["id"], title: typeof s["title"] === "string" ? s["title"] : "", node_path: typeof s["node_path"] === "string" ? s["node_path"] : null },
    observed_at: typeof o["observed_at"] === "string" ? o["observed_at"] : "",
    authority, status,
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
    approved_by: typeof o["approved_by"] === "string" ? o["approved_by"] : null,
    fingerprint,
  };
}
