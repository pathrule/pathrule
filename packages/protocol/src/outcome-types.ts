// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes of outcome observation: what was delivered to an agent, what the agent did, and the
 * categorical decisions about usage, condition and outcome that are stored as evidence. Types only.
 * Making those decisions is the backend's outcome observer; storing and reading them is open.
 */

/** How strongly we believe the agent acted on the advisory. Only ATTRIBUTED is positive evidence. */
export type UsageStatus = "NOT_OBSERVED" | "POSSIBLE" | "ATTRIBUTED" | "AMBIGUOUS";
/** What happened after an attributed action. UNKNOWN is the default and the honest common answer. */
export type OutcomeStatus = "SUCCEEDED" | "FAILED" | "UNKNOWN";
/** Categorical evidence strength; no confidence numbers, because they would imply a precision we lack. */
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK" | "NONE";
export type UsageEvidenceKind = "text_inserted" | "text_present" | "command_match" | null;
export type OutcomeEvidenceKind =
  | "exit_zero" | "exit_nonzero" | "check_pass" | "check_fail" | "error_persisted" | null;

/**
 * A machine-readable reason for a usage decision (Phase 37, Area Z). This is the debug trace: given a
 * session / atom / delivery, `reason` explains the matcher's decision without re-running it. It is a
 * closed enum, never free text, so it is safe to persist and to assert on.
 */
export type UsageReason =
  | "literal_inserted"            // ATTRIBUTED: a code-shaped literal appears in `after`, absent from `before`
  | "command_fingerprint_match"   // ATTRIBUTED: the executed command shares the advisory command's fingerprint
  | "multiple_strong_matches"     // AMBIGUOUS: >1 advisory equally, strongly matched by one event
  | "literal_present_not_inserted"// POSSIBLE: literal is present but not shown to be inserted now
  | "out_of_scope"                // NOT_OBSERVED: edit path is outside the advisory's scope
  | "no_literal_match"            // NOT_OBSERVED: no action literal found in the edit
  | "command_no_fingerprint_match"// NOT_OBSERVED: executed command fingerprint differs from the advisory's
  | "command_unfingerprintable"   // NOT_OBSERVED: the executed command could not be fingerprinted (fail closed)
  | "prose_unobservable"          // NOT_OBSERVED: the advisory has only procedural prose, not code-shaped literals
  | "literal_too_short";          // NOT_OBSERVED: the advisory's only literals are below the coincidence threshold

/** Condition observation status (Phase 9 / Area G): was the remedy's triggering condition seen at all? */
export type ConditionStatus = "OBSERVED" | "NOT_OBSERVED" | "UNOBSERVABLE";
export type ConditionEvidenceKind = "command_failed" | "error_signature" | null;

/** A delivered advisory, reduced to what attribution needs. `action_literals` are verbatim source spans. */
export interface DeliveredAdvisory {
  atom_id: string;
  scope: string | null;
  action_literals: string[];
  variant: "bind" | "trouble";
  /** Verbatim condition spans (the "when X" of the remedy). Optional: absent for callers that only match actions. */
  condition_literals?: string[];
}

export type ObservedEvent =
  | { kind: "edit"; path: string; before: string; after: string }
  | { kind: "write"; path: string; after: string }
  | { kind: "command"; command: string; exit_code: number | null; output?: string };

export interface UsageAttribution {
  atom_id: string;
  status: UsageStatus;
  evidence_kind: UsageEvidenceKind;
  strength: EvidenceStrength;
  reason: UsageReason;
}

export interface ConditionObservation {
  atom_id: string;
  status: ConditionStatus;
  evidence_kind: ConditionEvidenceKind;
  signature: string | null;
}

export interface OutcomeVerdict {
  atom_id: string;
  status: OutcomeStatus;
  evidence_kind: OutcomeEvidenceKind;
  strength: EvidenceStrength;
}
