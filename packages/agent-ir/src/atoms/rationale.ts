// SPDX-License-Identifier: Apache-2.0
/**
 * RATIONALE atoms: source-backed EXPLANATIONS for why a decision/rule/preference exists (V32).
 *
 * A RATIONALE preserves "X, because Y" without becoming another CONSTRAINT. It is knowledge, never
 * enforcement.
 *
 * FALSE_RATIONALE is SEMANTIC (the V31 lesson): a reason relationship the source does not actually
 * express is false knowledge even if the words are grounded. Two sentences next to each other are not
 * a rationale; correlation is not causality. So a RATIONALE is admitted ONLY when the source carries
 * an explicit reason connective (because / since / so that / in order to / to avoid / the reason ...)
 * AND the reason span is grounded. Hard target: FALSE_RATIONALE = 0. Prefer abstention.
 */
import { createHash } from "node:crypto";

import { isAdvisoryAuthority, isTrustedAdvisoryAuthority, type AdvisoryAuthority } from "./grounded.js";

export type RationaleStatus = "proposed" | "active" | "rejected";

export interface RationaleInput {
  /** What is being explained (a decision/preference/rule reference). Verbatim spans, or normalized. */
  subject_evidence: string[];
  /** The extractor's wording for the subject. NEVER shown as source evidence. Null when evidence exists. */
  subject_normalized: string | null;
  /** The reason (the "why"), source-verbatim. At least one is required. */
  reason_evidence: string[];
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

export interface RationaleAtom {
  id: string;
  kind: "rationale";
  subject_evidence: string[];
  subject_normalized: string | null;
  reason_evidence: string[];
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: AdvisoryAuthority;
  status: RationaleStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type RationaleValidationCode =
  | "rationale_no_reason"
  | "rationale_reason_not_grounded"
  | "rationale_no_reason_connective"
  | "rationale_reason_too_trivial"
  | "rationale_no_subject"
  | "rationale_source_missing";

export type RationaleValidation =
  | { ok: true; value: RationaleInput }
  | { ok: false; code: RationaleValidationCode; message: string };

export function rationaleFingerprint(input: { subject_evidence: string[]; reason_evidence: string[]; source: { kind: string; id: string } }): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    input.source.kind, input.source.id,
    [...input.subject_evidence].map(norm).sort().join(""),
    [...input.reason_evidence].map(norm).sort().join(""),
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex");
}

export function stampProposedRationale(value: RationaleInput, opts: { now: string }): RationaleAtom {
  const fingerprint = rationaleFingerprint(value);
  return {
    id: fingerprint, kind: "rationale",
    subject_evidence: value.subject_evidence,
    subject_normalized: value.subject_evidence.length > 0 ? null : value.subject_normalized,
    reason_evidence: value.reason_evidence,
    source: value.source, observed_at: value.observed_at,
    authority: "inferred", status: "proposed", created_at: opts.now, approved_by: null, fingerprint,
  };
}

export function approveRationale(atom: RationaleAtom, approvedBy: string): RationaleAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}
export function rejectRationale(atom: RationaleAtom, rejectedBy: string): RationaleAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this reach an agent? A person approved it and it is active. Rationale has no weak tier. */
export function isRationaleDeliverable(atom: RationaleAtom): boolean {
  return isTrustedAdvisoryAuthority(atom.authority) && atom.status === "active";
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export function parseRationaleAtom(raw: unknown): RationaleAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "rationale") return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (!isAdvisoryAuthority(authority)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const reasons = asStringArray(o["reason_evidence"]);
  if (reasons.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "rationale",
    subject_evidence: asStringArray(o["subject_evidence"]),
    subject_normalized: typeof o["subject_normalized"] === "string" ? o["subject_normalized"] : null,
    reason_evidence: reasons,
    source: { kind: s["kind"], id: s["id"], title: typeof s["title"] === "string" ? s["title"] : "", node_path: typeof s["node_path"] === "string" ? s["node_path"] : null },
    observed_at: typeof o["observed_at"] === "string" ? o["observed_at"] : "",
    authority, status,
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
    approved_by: typeof o["approved_by"] === "string" ? o["approved_by"] : null,
    fingerprint,
  };
}
