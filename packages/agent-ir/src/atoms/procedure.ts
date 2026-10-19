// SPDX-License-Identifier: Apache-2.0
/**
 * PROCEDURE atoms: source-backed ORDERED workflows, in production (V31).
 *
 * A PROCEDURE says "when doing operation X, follow these ordered steps". It is ADVISORY operational
 * guidance and inherits the REMEDY safety posture:
 *
 *  - It never auto-executes a command, never creates a CHECK, never creates a CONSTRAINT, and never
 *    grants authority. A step that happens to contain `pnpm test` does NOT mint a mandatory CHECK.
 *  - Human authority comes from an APPROVAL, never from the document the text sat in.
 *
 * Two hard safety metrics:
 *  - FALSE_PROCEDURE_STEP = 0: every stored step is byte-present in the source; a step the model
 *    invented is rejected.
 *  - ORDER_CORRUPTION = 0: stored steps appear in the source in the SAME order. Because grounding is
 *    byte-exact, this is decidable: the steps' first offsets in the source must be strictly
 *    increasing. A reordered list fails deterministically, with no model in the loop.
 *
 * A one-step "procedure" is a single action (a REMEDY's job), not a workflow, so at least two ordered
 * steps are required.
 */
import { createHash } from "node:crypto";

import { isAdvisoryAuthority, isTrustedAdvisoryAuthority, type AdvisoryAuthority } from "./grounded.js";

/** Lifecycle. Same three words as REMEDY: a person declining a procedure is a normal outcome. */
export type ProcedureStatus = "proposed" | "active" | "rejected";

/** What the write path hands in. Authority, status and identity are derived. */
export interface ProcedureInput {
  /** Verbatim trigger/operation ("when adding a database migration"). Empty only when composed. */
  operation_evidence: string[];
  /** The extractor's wording for the operation. NEVER shown as source evidence. Null when evidence exists. */
  operation_normalized: string | null;
  /** Ordered, verbatim step spans. At least two, in source order. */
  steps: string[];
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

/** Stored shape. `steps` preserves order by array index. */
export interface ProcedureAtom {
  id: string;
  kind: "procedure";
  operation_evidence: string[];
  operation_normalized: string | null;
  steps: string[];
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: AdvisoryAuthority;
  status: ProcedureStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type ProcedureValidationCode =
  | "procedure_no_operation"
  | "procedure_too_few_steps"
  | "procedure_step_not_grounded"
  | "procedure_duplicate_step"
  | "procedure_order_corrupted"
  | "procedure_source_missing";

export type ProcedureValidation =
  | { ok: true; value: ProcedureInput }
  | { ok: false; code: ProcedureValidationCode; message: string };

/** The minimum ordered steps for a workflow. One step is a single action (REMEDY), not a procedure. */
export const MIN_PROCEDURE_STEPS = 2;

/**
 * Deterministic identity over source + operation + the ORDERED steps. Order is part of identity (a
 * procedure is defined by its sequence), so steps are joined in order, NOT sorted, unlike REMEDY's
 * order-free action set.
 */
export function procedureFingerprint(input: {
  operation_evidence: string[];
  steps: string[];
  source: { kind: string; id: string };
}): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    input.source.kind,
    input.source.id,
    [...input.operation_evidence].map(norm).sort().join(""),
    input.steps.map(norm).join(">"), // ordered, not sorted
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex");
}

/** Stamp a validated input as a PROPOSAL. The only entry point from the write path. */
export function stampProposedProcedure(value: ProcedureInput, opts: { now: string }): ProcedureAtom {
  const fingerprint = procedureFingerprint(value);
  return {
    id: fingerprint,
    kind: "procedure",
    operation_evidence: value.operation_evidence,
    operation_normalized: value.operation_evidence.length > 0 ? null : value.operation_normalized,
    steps: value.steps,
    source: value.source,
    observed_at: value.observed_at,
    authority: "inferred",
    status: "proposed",
    created_at: opts.now,
    approved_by: null,
    fingerprint,
  };
}

/** A person accepts the workflow. Does not execute a step, does not create a CHECK, does not grant authority. */
export function approveProcedure(atom: ProcedureAtom, approvedBy: string): ProcedureAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}

/** Declining a procedure. Persisted, so the same evidence does not return as a new proposal. */
export function rejectProcedure(atom: ProcedureAtom, rejectedBy: string): ProcedureAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this reach an agent? A person approved it and it is active. Procedures have no weak-evidence tier. */
export function isProcedureDeliverable(atom: ProcedureAtom): boolean {
  return isTrustedAdvisoryAuthority(atom.authority) && atom.status === "active";
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/** Defensive parse of a stored payload. Malformed rows degrade to "skip this atom", never crash a read. */
export function parseProcedureAtom(raw: unknown): ProcedureAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "procedure") return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (!isAdvisoryAuthority(authority)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const steps = asStringArray(o["steps"]);
  if (steps.length < MIN_PROCEDURE_STEPS) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "procedure",
    operation_evidence: asStringArray(o["operation_evidence"]),
    operation_normalized: typeof o["operation_normalized"] === "string" ? o["operation_normalized"] : null,
    steps,
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
