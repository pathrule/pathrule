// SPDX-License-Identifier: Apache-2.0
/**
 * Capture: an agent states what it learned as a typed atom, grounded in the memory it is writing.
 *
 * The agent in the session (Claude, Codex, ...) already understood the knowledge; it names the kind
 * and quotes the spans. This module never judges meaning, so it needs no model and reads every
 * language the same way. It proves only what a machine can prove:
 *
 *  - every span is non-empty, bounded, and VERBATIM in the source text;
 *  - each kind has the parts it needs (a remedy has an action, a selection an alternative, a
 *    procedure at least MIN_PROCEDURE_STEPS steps that appear in the source in that order);
 *  - the parts are distinct (an action is not its own condition, a choice is not its own alternative);
 *  - only states that are DELIVERED may be captured (a hedged fix, a provisional preference or a
 *    historical fact stays in the memory body, where Foundation still delivers it).
 *
 * A passing atom is GROUNDED and active (`grounded.ts`); its scope is its source's node, so it can
 * never reach wider than the memory it came from. Delivery re-proves the spans against the
 * source's current text, so a later edit that drops them silences the atom.
 */
import { activateGrounded } from "./grounded.js";
import { stampProposedRemedy } from "./remedy-fingerprint.js";
import { stampProposedSelection } from "./selection-fingerprint.js";
import { stampProposedContext } from "./context-fingerprint.js";
import { MIN_PROCEDURE_STEPS, stampProposedProcedure } from "./procedure.js";
import { stampProposedRationale } from "./rationale.js";
import type { RemedyAtom, RemedyEvidenceState } from "./remedy.js";
import type { SelectionAtom } from "./selection.js";
import type { ProcedureAtom } from "./procedure.js";
import type { ContextAtom } from "./context.js";
import type { RationaleAtom } from "./rationale.js";

/** What an agent sends. Every string is a span copied verbatim from the memory body. */
export type GroundedAtomClaim =
  | { kind: "remedy"; condition: string[]; action: string[]; variant?: "trouble" | "bind"; evidence?: "observed_success" | "repeated_success" | "human_authored" }
  | { kind: "selection"; prefer: string[]; over: string[]; context?: string[] }
  | { kind: "procedure"; operation: string[]; steps: string[] }
  | { kind: "context"; fact: string[] }
  | { kind: "rationale"; subject: string[]; reason: string[] };

export type CapturedAtom = RemedyAtom | SelectionAtom | ProcedureAtom | ContextAtom | RationaleAtom;

export type GroundedCaptureCode =
  | "capture_unknown_kind"
  | "capture_missing_part"
  | "capture_span_too_long"
  | "capture_span_not_in_source"
  | "capture_parts_overlap"
  | "capture_steps_out_of_order"
  | "capture_too_few_steps";

export type GroundedCapture =
  | { ok: true; atom: CapturedAtom }
  | { ok: false; code: GroundedCaptureCode; message: string };

export interface CaptureSource {
  kind: "memory" | "rule";
  id: string;
  title: string;
  /** The body the spans must be found in, as it is stored. */
  content: string;
}

/** A span longer than this is a paragraph, not evidence. */
export const MAX_SPAN_CHARS = 400;
/** At most this many atoms ride on one write. */
export const MAX_ATOMS_PER_WRITE = 6;

const EVIDENCE_STATE: Record<string, RemedyEvidenceState> = {
  observed_success: "OBSERVED_SUCCESS",
  repeated_success: "REPEATED_SUCCESS",
  human_authored: "HUMAN_AUTHORED",
};

const fail = (code: GroundedCaptureCode, message: string): GroundedCapture => ({ ok: false, code, message });

function spans(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v.length > 0) : [];
}

/** The first problem with a group of spans, or null. */
function checkSpans(name: string, list: string[], content: string, required: boolean): GroundedCapture | null {
  if (required && list.length === 0) return fail("capture_missing_part", `"${name}" needs at least one span quoted from the memory.`);
  for (const span of list) {
    if (span.length > MAX_SPAN_CHARS) return fail("capture_span_too_long", `A "${name}" span is over ${MAX_SPAN_CHARS} characters; quote the shortest exact phrase.`);
    if (!content.includes(span)) return fail("capture_span_not_in_source", `A "${name}" span is not verbatim in the memory body: "${span.slice(0, 80)}".`);
  }
  return null;
}

function overlaps(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x));
}

/** Prove one claim against its source. Pure and deterministic. */
export function captureGroundedAtom(claim: GroundedAtomClaim, source: CaptureSource, now: string): GroundedCapture {
  const content = source.content;
  const src = { kind: source.kind, id: source.id, title: source.title, node_path: null };
  const c = claim as Record<string, unknown>;
  switch (claim.kind) {
    case "remedy": {
      const condition = spans(c["condition"]), action = spans(c["action"]);
      const problem = checkSpans("condition", condition, content, true) ?? checkSpans("action", action, content, true);
      if (problem) return problem;
      if (overlaps(condition, action)) return fail("capture_parts_overlap", "An action span repeats a condition span; quote what to DO separately from when.");
      const evidence = EVIDENCE_STATE[String(c["evidence"] ?? "observed_success")];
      if (!evidence) return fail("capture_missing_part", 'Remedy "evidence" must be observed_success, repeated_success or human_authored.');
      const variant = c["variant"] === "bind" ? "bind" : "trouble";
      const atom = stampProposedRemedy({ variant, condition_evidence: condition, condition_normalized: null, action_evidence: action, evidence_state: evidence, source: src, observed_at: now }, { now });
      return { ok: true, atom: activateGrounded(atom) };
    }
    case "selection": {
      const prefer = spans(c["prefer"]), over = spans(c["over"]), context = spans(c["context"]);
      const problem = checkSpans("prefer", prefer, content, true) ?? checkSpans("over", over, content, true) ?? checkSpans("context", context, content, false);
      if (problem) return problem;
      if (overlaps(prefer, over)) return fail("capture_parts_overlap", 'A "prefer" span is also an "over" span.');
      const atom = stampProposedSelection({ context_evidence: context, context_normalized: null, preferred_evidence: prefer, alternative_evidence: over, strength: "ESTABLISHED", source: src, observed_at: now }, { now });
      return { ok: true, atom: activateGrounded(atom) };
    }
    case "procedure": {
      const operation = spans(c["operation"]), steps = spans(c["steps"]);
      const problem = checkSpans("operation", operation, content, true) ?? checkSpans("steps", steps, content, true);
      if (problem) return problem;
      if (steps.length < MIN_PROCEDURE_STEPS) return fail("capture_too_few_steps", `A procedure needs at least ${MIN_PROCEDURE_STEPS} steps.`);
      let from = 0;
      for (const step of steps) {
        const at = content.indexOf(step, from);
        if (at < 0) return fail("capture_steps_out_of_order", "The steps must appear in the memory in the order given.");
        from = at + step.length;
      }
      const atom = stampProposedProcedure({ operation_evidence: operation, operation_normalized: null, steps, source: src, observed_at: now }, { now });
      return { ok: true, atom: activateGrounded(atom) };
    }
    case "context": {
      const fact = spans(c["fact"]);
      const problem = checkSpans("fact", fact, content, true);
      if (problem) return problem;
      const atom = stampProposedContext({ fact_evidence: fact, fact_normalized: null, topic: null, temporal_status: "CURRENT", source: src, observed_at: now }, { now });
      return { ok: true, atom: activateGrounded(atom) };
    }
    case "rationale": {
      const subject = spans(c["subject"]), reason = spans(c["reason"]);
      const problem = checkSpans("subject", subject, content, true) ?? checkSpans("reason", reason, content, true);
      if (problem) return problem;
      if (overlaps(subject, reason)) return fail("capture_parts_overlap", 'A "reason" span repeats a "subject" span.');
      const atom = stampProposedRationale({ subject_evidence: subject, subject_normalized: null, reason_evidence: reason, source: src, observed_at: now }, { now });
      return { ok: true, atom: activateGrounded(atom) };
    }
    default:
      return fail("capture_unknown_kind", 'kind must be one of remedy, selection, procedure, context, rationale.');
  }
}
