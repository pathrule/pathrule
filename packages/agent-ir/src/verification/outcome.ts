// SPDX-License-Identifier: Apache-2.0
/**
 * Outcome observation: did the agent USE a delivered REMEDY, and did it work?
 *
 * V29 answers "was it delivered?". This layer adds a conservative, deterministic, model-free
 * attribution of USAGE and a narrow OUTCOME, keeping the epistemic ladder strictly separated:
 *
 *   DELIVERED  -> the advisory was placed in agent context (V29)
 *   OBSERVED   -> some tool event happened after delivery
 *   USED       -> deterministic evidence the agent acted ON this advisory (attribution)
 *   OUTCOME    -> what happened after the attributed action (narrow, often UNKNOWN)
 *   CAUSED     -> NOT decided here; V30 never claims causality
 *
 * The governing rule is that UNKNOWN is a first-class, correct answer. False attribution poisons
 * future ranking, so the two hard metrics are FALSE_USAGE_ATTRIBUTION = 0 and
 * FALSE_SUCCESS_ATTRIBUTION = 0: nothing is marked ATTRIBUTED / SUCCEEDED unless the evidence forces
 * it. Lack of usage is NOT failure (the condition may never have occurred); a command running is not
 * success; a task ending is not success.
 *
 * Everything here is pure. No model call, no I/O. It compares LIVE tool input (available only in the
 * hook / runtime process, never persisted) against a delivered advisory's action literals, and
 * returns only a categorical decision plus a reason code, so no knowledge content has to be stored to
 * attribute. Every decision carries a `reason` (Phase 37 / debug trace) so a future reviewer can see
 * exactly WHY an event was or was not attributed, without re-deriving it.
 *
 * This is the open authority (owner decision 2026-10-15), so the observation loop runs without an
 * installed engine. The engine still carries an identical copy in its qualified build; its
 * `outcome-parity.test.ts` pins the two to the same decisions on the frozen corpus.
 */
import { classifyVerificationCommand } from "./verification-evidence.js";
import { scopeApplies } from "../delivery/agent-ir.js";
import type {
  UsageEvidenceKind,
  UsageReason,
  DeliveredAdvisory,
  ObservedEvent,
  UsageAttribution,
  ConditionObservation,
  OutcomeVerdict,
} from "@pathrule/protocol/outcome-types.js";

// The decision shapes are part of the open evidence format (@pathrule/protocol).
export type {
  UsageStatus,
  OutcomeStatus,
  EvidenceStrength,
  UsageEvidenceKind,
  OutcomeEvidenceKind,
  UsageReason,
  ConditionStatus,
  ConditionEvidenceKind,
  DeliveredAdvisory,
  ObservedEvent,
  UsageAttribution,
  ConditionObservation,
  OutcomeVerdict,
} from "@pathrule/protocol/outcome-types.js";

/** The shortest action literal worth matching. Below this a match is coincidence, not evidence. */
const MIN_LITERAL_CHARS = 4;

function usableLiterals(a: DeliveredAdvisory): string[] {
  return a.action_literals.filter((l) => typeof l === "string" && l.trim().length >= MIN_LITERAL_CHARS);
}

/**
 * Only CODE-SHAPED literals are matched against edited text. A multi-word natural-language phrase
 * ("review the design before building") is procedural prose (Phase 6, family D): it must stay
 * unobservable rather than be text-matched, because a prose phrase appearing in a file is not
 * evidence the agent acted on the advisory. A literal qualifies if it is a single token (no
 * whitespace) or carries code punctuation.
 */
const CODE_PUNCT = /[()[\]{}.:;=<>/\\@$_#-]/;
function isCodeShaped(l: string): boolean {
  return !/\s/.test(l) || CODE_PUNCT.test(l);
}

interface PerAtom { atom_id: string; strong: boolean; weak: boolean; kind: UsageEvidenceKind; reason: UsageReason; }

/** Classify ONE advisory against ONE event, before cross-advisory ambiguity is resolved. */
function classifyOne(a: DeliveredAdvisory, event: ObservedEvent): PerAtom {
  if (event.kind === "command") {
    const obs = classifyVerificationCommand(event.command);
    if (!obs) return { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "command_unfingerprintable" };
    const matches = usableLiterals(a).some((l) => { const s = classifyVerificationCommand(l); return s && s.fingerprint === obs.fingerprint; });
    return matches
      ? { atom_id: a.atom_id, strong: true, weak: false, kind: "command_match", reason: "command_fingerprint_match" }
      : { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "command_no_fingerprint_match" };
  }
  // edit / write: scope must contain the path; only code-shaped literals are text-matchable
  if (!scopeApplies(a.scope, event.path)) return { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "out_of_scope" };
  const usable = usableLiterals(a);
  if (usable.length === 0) return { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "literal_too_short" };
  const lits = usable.filter(isCodeShaped);
  if (lits.length === 0) return { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "prose_unobservable" };
  const after = event.after;
  const before = event.kind === "edit" ? event.before : "";
  const inserted = lits.some((l) => after.includes(l) && !before.includes(l));
  const present = lits.some((l) => after.includes(l));
  if (inserted && event.kind === "edit") return { atom_id: a.atom_id, strong: true, weak: false, kind: "text_inserted", reason: "literal_inserted" };
  if (present) return { atom_id: a.atom_id, strong: false, weak: true, kind: "text_present", reason: "literal_present_not_inserted" };
  return { atom_id: a.atom_id, strong: false, weak: false, kind: null, reason: "no_literal_match" };
}

/**
 * Attribute one observed tool event to the delivered advisories. Returns a decision for EVERY
 * delivered advisory (NOT_OBSERVED when nothing matched), so a caller can record the full picture.
 *
 * Insertion, not presence: for an Edit we require the literal to be in `after` AND absent from
 * `before` (the agent added it now), never merely present. A Write shows only the final content, so
 * it can reach POSSIBLE but never ATTRIBUTED on text alone. Scope is enforced first: an edit outside
 * an advisory's scope is never its evidence, even if the literal matches. When more than one advisory
 * is equally, strongly matched by the SAME event, all of them are AMBIGUOUS rather than one being
 * chosen: a single action must not be counted as using five remedies.
 */
export function attributeUsage(delivered: DeliveredAdvisory[], event: ObservedEvent): UsageAttribution[] {
  const perAtom = delivered.map((a) => classifyOne(a, event));
  const strongCount = perAtom.filter((p) => p.strong).length;
  const ambiguous = strongCount > 1;
  return perAtom.map((p) => {
    if (p.strong) {
      return ambiguous
        ? { atom_id: p.atom_id, status: "AMBIGUOUS" as const, evidence_kind: p.kind, strength: "WEAK" as const, reason: "multiple_strong_matches" as const }
        : { atom_id: p.atom_id, status: "ATTRIBUTED" as const, evidence_kind: p.kind, strength: "STRONG" as const, reason: p.reason };
    }
    if (p.weak) return { atom_id: p.atom_id, status: "POSSIBLE" as const, evidence_kind: "text_present" as const, strength: "WEAK" as const, reason: p.reason };
    return { atom_id: p.atom_id, status: "NOT_OBSERVED" as const, evidence_kind: null, strength: "NONE" as const, reason: p.reason };
  });
}

// ── Condition observation (Phase 9 / Phase 44 / Area G) ─────────────────────────────────────────
// A REMEDY is conditional ("when X fails, do Y"). If X never happened, absence of Y is meaningless.
// This is observed SEPARATELY from the action, and only from deterministic runtime evidence: a
// command the remedy names failing (exit non-zero, same fingerprint), or a stable error signature
// from the remedy's condition text reappearing in command output. Prose conditions are UNOBSERVABLE.

/**
 * Deterministic, stable error signature (Phase 47 / Area H). Normalizes volatile detail out of an
 * error line so the SAME underlying error hashes identically across runs, while DIFFERENT errors do
 * not collide: absolute/relative paths, line:col positions, hex/pointers, numbers, quoted literals
 * and timestamps are neutralized, then the residual shape is lowercased and whitespace-collapsed.
 * Returns null for text with no error-shaped content, so noise never becomes a signature.
 */
export function errorSignature(text: string | null | undefined): string | null {
  if (!text) return null;
  const raw = (text.split(/\r?\n/).find((l) => /error|exception|failed|cannot|not found|undefined|einval|eacces|panic|traceback/i.test(l)) ?? "").trim();
  if (raw.length < 6) return null;
  // Strip a leading "<path>:<line>:<col> - " location prefix (tsc/eslint style) and a level/code
  // marker ("Error:", "error TS2304:", "TypeError:") so a bare condition phrase and a full compiler
  // line reduce to the SAME core message. Deterministic, order-independent.
  const line = raw
    .replace(/^\S+:\d+:\d+\s*-\s*/, "")
    .replace(/^\S+:\d+\s*-\s*/, "")
    .replace(/^(?:error(?:\s+ts\d+)?|warning|exception|typeerror|referenceerror|syntaxerror|rangeerror)\s*:\s*/i, "")
    .trim();
  if (line.length < 6) return null;
  const norm = line
    .replace(/[a-z]:[\\/][^\s:]+|(?:\.{0,2}\/)[^\s:]+/gi, "<path>") // file paths
    .replace(/:\d+:\d+|:\d+\b/g, "<pos>")                            // line:col
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "<lit>")                    // quoted specifics
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return norm.length >= 6 ? norm : null;
}

/**
 * Was this advisory's triggering condition observed in the event? OBSERVED only on hard evidence: a
 * command matching a condition command's fingerprint exiting non-zero, or an error signature derived
 * from the advisory's condition text appearing in the command output. Otherwise NOT_OBSERVED, or
 * UNOBSERVABLE when the advisory has no deterministically observable condition at all. Never guesses.
 */
export function observeCondition(a: DeliveredAdvisory, event: ObservedEvent): ConditionObservation {
  const conds = (a.condition_literals ?? []).filter((c) => typeof c === "string" && c.trim().length >= MIN_LITERAL_CHARS);
  const condSignatures = conds.map((c) => errorSignature(c)).filter((s): s is string => !!s);
  const condCommands = conds.filter((c) => !!classifyVerificationCommand(c));
  if (condSignatures.length === 0 && condCommands.length === 0) {
    return { atom_id: a.atom_id, status: "UNOBSERVABLE", evidence_kind: null, signature: null };
  }
  if (event.kind === "command") {
    const obs = classifyVerificationCommand(event.command);
    if (obs && (event.exit_code ?? 0) !== 0) {
      const cmdMatch = condCommands.some((c) => { const s = classifyVerificationCommand(c); return s && s.fingerprint === obs.fingerprint; });
      if (cmdMatch) return { atom_id: a.atom_id, status: "OBSERVED", evidence_kind: "command_failed", signature: obs.fingerprint };
    }
    const outSig = errorSignature(event.output);
    if (outSig && condSignatures.includes(outSig)) return { atom_id: a.atom_id, status: "OBSERVED", evidence_kind: "error_signature", signature: outSig };
  }
  return { atom_id: a.atom_id, status: "NOT_OBSERVED", evidence_kind: null, signature: null };
}

/**
 * Narrow outcome for a COMMAND remedy the agent ran: exit 0 is MODERATE success of THAT command,
 * exit non-zero is MODERATE failure. This is deliberately narrow: command success is not task
 * success, and only a command remedy attributed by command_match is eligible. Everything else stays
 * UNKNOWN. A code-change remedy has no outcome here; its only trustworthy verifier is a CHECK
 * transition (classifyCheckOutcome), which the runtime supplies when it has one.
 */
export function classifyCommandOutcome(attribution: UsageAttribution, exitCode: number | null): OutcomeVerdict {
  if (attribution.status !== "ATTRIBUTED" || attribution.evidence_kind !== "command_match" || exitCode == null) {
    return { atom_id: attribution.atom_id, status: "UNKNOWN", evidence_kind: null, strength: "NONE" };
  }
  return exitCode === 0
    ? { atom_id: attribution.atom_id, status: "SUCCEEDED", evidence_kind: "exit_zero", strength: "MODERATE" }
    : { atom_id: attribution.atom_id, status: "FAILED", evidence_kind: "exit_nonzero", strength: "MODERATE" };
}

/**
 * STRONG outcome from a deterministic CHECK transition: a verification that was FAILING before an
 * attributed action and PASSES after it, for the SAME fingerprint, is strong positive evidence; the
 * reverse (still failing) is strong negative. With no transition, UNKNOWN. The runtime is responsible
 * for only calling this when the CHECK is defensibly related to the remedy's scope (a global "some
 * check passed" is not passed in here).
 */
export function classifyCheckOutcome(
  attribution: UsageAttribution,
  transition: { was_failing: boolean; now_passing: boolean } | null,
): OutcomeVerdict {
  if (attribution.status !== "ATTRIBUTED" || !transition) {
    return { atom_id: attribution.atom_id, status: "UNKNOWN", evidence_kind: null, strength: "NONE" };
  }
  if (transition.was_failing && transition.now_passing) return { atom_id: attribution.atom_id, status: "SUCCEEDED", evidence_kind: "check_pass", strength: "STRONG" };
  if (transition.was_failing && !transition.now_passing) return { atom_id: attribution.atom_id, status: "FAILED", evidence_kind: "check_fail", strength: "STRONG" };
  return { atom_id: attribution.atom_id, status: "UNKNOWN", evidence_kind: null, strength: "NONE" };
}

/**
 * STRONG negative outcome (Phase 15): the SAME error signature the condition was observed under is
 * still present in a later command's output, after the action was attributed. That is narrow negative
 * evidence that the remedy did not resolve its own condition. A DIFFERENT or absent signature is
 * UNKNOWN (the error may have changed, or the verifier is silent), never a success claim.
 */
export function classifyErrorPersistenceOutcome(
  attribution: UsageAttribution,
  conditionSignature: string | null,
  laterOutput: string | null | undefined,
): OutcomeVerdict {
  if (attribution.status !== "ATTRIBUTED" || !conditionSignature) {
    return { atom_id: attribution.atom_id, status: "UNKNOWN", evidence_kind: null, strength: "NONE" };
  }
  const laterSig = errorSignature(laterOutput);
  if (laterSig && laterSig === conditionSignature) {
    return { atom_id: attribution.atom_id, status: "FAILED", evidence_kind: "error_persisted", strength: "STRONG" };
  }
  return { atom_id: attribution.atom_id, status: "UNKNOWN", evidence_kind: null, strength: "NONE" };
}
