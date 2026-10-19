// SPDX-License-Identifier: Apache-2.0
// The shapes of Knowledge Maintenance: findings, cases, evidence, proposals, runs, estimates and
// the analysis contract's inputs and outputs. The analysis is an engine's
// (`MaintenanceAnalyzer`); the host validates these shapes, shows them to a person, and applies or
// rolls back only what that person approved.

import type { Suggestion } from "./suggestions.js";
export type MaintenanceSourceKind =
  | "repo"
  | "rule"
  | "memory"
  | "skill"
  | "signal"
  | "activity"
  | "team_intelligence";

/** Personal intelligence is presentation-only and deliberately not evidence. */
export type MaintenancePersonalizationSource = "personal_intelligence";

export type MaintenanceSubjectKind =
  | "memory"
  | "rule"
  | "skill"
  | "signal"
  | "activity"
  | "path";

export type MaintenanceCaseType =
  | "stale_knowledge"
  | "conflicting_knowledge"
  // Distinct from conflicting_knowledge on purpose: a conflict is two statements
  // that cannot both be true, a duplicate is two that are both true and identical.
  // They resolve in opposite ways (decide vs merge).
  | "duplicate_knowledge"
  | "broken_reference"
  | "missing_knowledge"
  | "rule_adherence_gap"
  | "skill_effectiveness_gap"
  | "repeated_work_candidate"
  | "team_alignment_gap";

export type MaintenanceSeverity = "info" | "attention" | "risk";
export type MaintenanceConfidenceBand = "low" | "medium" | "high";
export type MaintenanceExecutionClass =
  | "ready_without_ai"
  | "cheap_ai_review"
  | "needs_user_engine"
  | "needs_human_decision";

export type MaintenanceCaseStatus =
  | "open"
  | "queued"
  | "running"
  | "ready"
  | "applied"
  | "rejected"
  | "snoozed"
  | "failed"
  | "superseded";

export interface MaintenanceSubjectLocator {
  kind: MaintenanceSubjectKind;
  id?: string | null;
  path?: string | null;
}

export interface MaintenanceConfidenceComponents {
  detector: number;
  evidenceCoverage: number;
  sourceAgreement: number;
  freshness: number;
}

export interface MaintenanceFinding {
  id: string;
  workspaceId: string;
  detectorId: string;
  detectorVersion: number;
  findingType: MaintenanceCaseType;
  subject: MaintenanceSubjectLocator;
  severity: MaintenanceSeverity;
  confidence: MaintenanceConfidenceComponents;
  evidenceLocators: string[];
  sourceFingerprint: string;
  status: "active" | "resolved" | "suppressed";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  legacySuggestionId: string | null;
}

export interface MaintenanceEvidence {
  id: string;
  caseId: string;
  sourceKind: MaintenanceSourceKind;
  sourceId: string | null;
  locator: string;
  authority: number;
  observedAt: string;
  contentHash: string;
  safeExcerpt: string | null;
  metadata: Record<string, unknown>;
}

export interface MaintenanceCase {
  id: string;
  workspaceId: string;
  topicKey: string;
  caseType: MaintenanceCaseType;
  title: string;
  summary: string;
  severity: MaintenanceSeverity;
  confidenceBand: MaintenanceConfidenceBand;
  confidenceComponents: MaintenanceConfidenceComponents;
  executionClass: MaintenanceExecutionClass;
  status: MaintenanceCaseStatus;
  sourceFingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  version: number;
}

export type MaintenanceProposalOperation =
  | {
      kind: "create_memory";
      nodePath: string;
      title: string;
      body: string;
    }
  | {
      kind: "update_memory";
      targetId: string;
      title?: string;
      body?: string;
    }
  | {
      kind: "archive_memory";
      targetId: string;
    }
  | {
      kind: "create_rule";
      nodePath: string;
      title: string;
      body: string;
    }
  | {
      kind: "update_rule";
      targetId: string;
      title?: string;
      body?: string;
    }
  | {
      kind: "archive_rule";
      targetId: string;
    }
  | {
      kind: "create_skill";
      nodePath: string;
      name: string;
      body: string;
    }
  | {
      kind: "update_skill";
      targetId: string;
      name?: string;
      body?: string;
    }
  | {
      kind: "archive_skill";
      targetId: string;
    }
  | {
      kind: "no_change";
      reason: string;
    };

export interface MaintenanceProposal {
  id: string;
  workspaceId: string;
  caseId: string;
  version: number;
  status:
    | "draft"
    | "ready"
    | "applying"
    | "applied"
    | "partially_applied"
    | "rolling_back"
    | "rolled_back"
    | "rejected"
    | "stale";
  sourceFingerprint: string;
  summary: string;
  operations: MaintenanceProposalOperation[];
  preconditionHashes: Record<string, string>;
  createdByKind: "deterministic" | "pathrule_haiku" | "user_engine";
  createdByModel: string | null;
  createdAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  parentProposalId: string | null;
  selectedOperationIndexes: number[] | null;
  operationResults: MaintenanceOperationApplyResult[];
  rollbackAvailable: boolean;
}

export interface MaintenanceOperationApplyResult {
  index: number;
  kind: MaintenanceProposalOperation["kind"];
  targetId: string | null;
  status: "applied" | "compensated" | "failed" | "no_change";
  resultingVersionId: string | null;
  postconditionHash: string | null;
  errorCode: string | null;
}

export type MaintenanceRollbackOperation =
  | {
      kind: "restore_update";
      targetKind: "memory" | "rule" | "skill";
      targetId: string;
      label: string;
      body: string;
      expectedVersionId: string;
      expectedPostconditionHash: string;
    }
  | {
      kind: "restore_archive";
      targetKind: "memory" | "rule" | "skill";
      targetId: string;
      expectedPostconditionHash: string;
    }
  | {
      kind: "archive_created";
      targetKind: "memory" | "rule" | "skill";
      targetId: string;
      expectedVersionId: string;
      expectedPostconditionHash: string;
    }
  | {
      kind: "no_change";
    };

export interface MaintenanceRollbackPlan {
  proposalId: string;
  sourceFingerprint: string;
  createdAt: string;
  operations: MaintenanceRollbackOperation[];
}

export type MaintenanceRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "budget_exhausted"
  | "stale_input";

export type MaintenanceRouteTier =
  | "deterministic"
  | "pathrule_voyage"
  | "pathrule_haiku"
  | "user_cheap"
  | "user_balanced"
  | "user_strong";

export interface MaintenanceUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  filesRead: number;
  turns: number;
  elapsedMs: number;
}

export interface MaintenanceBudget extends MaintenanceUsage {}

export interface MaintenanceRun {
  id: string;
  workspaceId: string;
  caseId: string;
  taskKind: string;
  routeTier: MaintenanceRouteTier;
  provider: string | null;
  model: string | null;
  status: MaintenanceRunStatus;
  budget: MaintenanceBudget;
  estimatedUsage: MaintenanceUsage;
  actualUsage: MaintenanceUsage;
  startedAt: string | null;
  finishedAt: string | null;
  stopReason: string | null;
  errorCode: string | null;
}

export type MaintenanceEventType =
  | "case_created"
  | "case_regrouped"
  | "case_reopened"
  | "run_started"
  | "run_stopped"
  | "proposal_created"
  | "proposal_edited"
  | "proposal_apply_started"
  | "proposal_applied"
  | "proposal_partially_applied"
  | "proposal_apply_failed"
  | "case_rejected"
  | "case_snoozed"
  | "rollback_started"
  | "rollback_applied"
  | "rollback_failed"
  | "entitlement_blocked"
  | "budget_exhausted";

export interface MaintenanceEvent {
  id: string;
  workspaceId: string;
  caseId: string;
  type: MaintenanceEventType;
  actorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MaintenanceCaseUserState {
  caseId: string;
  userId: string;
  rankDelta: number;
  rankReason: "none" | "recently_rejected" | "frequently_used_topic" | "personal_preference";
  seenAt: string | null;
  snoozedUntil: string | null;
  personalizedHidden: boolean;
  lastDecision: "none" | "applied" | "rejected" | "snoozed";
}

// ─── The maintenance API's shapes ────────────────────────────────────────────

export type MaintenanceApiErrorCode =
  | "invalid_payload"
  | "no_session"
  | "forbidden"
  | "not_found"
  | "capability_disabled"
  | "unsupported_on_surface"
  | "conflict"
  | "internal_error";

export interface MaintenanceApiError {
  code: MaintenanceApiErrorCode;
  message: string;
  retryable: boolean;
}

export type MaintenanceApiResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: MaintenanceApiError };

export interface MaintenanceCaseDetail {
  maintenanceCase: MaintenanceCase;
  findings: MaintenanceFinding[];
  evidence: MaintenanceEvidence[];
  proposal: MaintenanceProposal | null;
}

/**
 * Rollout state for memories that existed before Git freshness tracking began.
 * "Unverified" means Pathrule has not yet seen a deliberate edit or completed
 * review since the baseline; it does not mean the memory is stale.
 */
export interface MaintenanceFreshnessSummary {
  tracking: boolean;
  branch: string | null;
  baselineSha: string | null;
  baselineAt: string | null;
  lastCompletedAt: string | null;
  legacyTotalCount: number;
  legacyUnverifiedCount: number;
}

export interface MaintenanceEstimate {
  taskKind: MaintenanceTaskKind;
  route: MaintenanceRouteDecision;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  hardInputTokenCap: number;
  hardOutputTokenCap: number;
  hardToolCap: number;
  hardFileCap: number;
  hardTurnCap: number;
  hardTimeMs: number;
  requiresExplicitStrongApproval: boolean;
  requiresUserEngineConsent: boolean;
}

export type MaintenanceUserEngineConsent = "undecided" | "allowed" | "disabled";
export type MaintenanceStrongModelPolicy = "ask_each_time" | "always_allow" | "never";

export interface MaintenanceEnginePreferences {
  userEngineConsent: MaintenanceUserEngineConsent;
  strongModelPolicy: MaintenanceStrongModelPolicy;
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export type MaintenanceTaskKind =
  | "deterministic_scan"
  | "semantic_cluster"
  | "conflict_adjudication"
  | "actionability_classification"
  | "small_proposal"
  | "repo_verification"
  | "complex_proposal";

export type MaintenanceModelClass = "cheap" | "balanced" | "strong";

export interface MaintenanceTask {
  kind: MaintenanceTaskKind;
  requiresModel: boolean;
  requiresRepo: boolean;
  requiresTools: boolean;
  complexity: "small" | "standard" | "complex";
  estimatedUsage: MaintenanceUsage;
}

export interface MaintenanceModelCandidate {
  agent: string;
  provider: string;
  model: string;
  class: MaintenanceModelClass;
  relativeCost: number;
  available: boolean;
  structuredOutput: boolean;
  tools: boolean;
}

/** A model an agent CLI offers, before the host knows whether it is available here. */
export type MaintenanceModelEntry = Omit<MaintenanceModelCandidate, "available">;

export interface MaintenanceRouteInput {
  task: MaintenanceTask;
  teamPlus: boolean;
  pathruleAiEnabled: boolean;
  userEngineEnabled: boolean;
  explicitStrongApproval: boolean;
  preferredAgent?: string | null;
  candidates?: readonly MaintenanceModelCandidate[];
}

export type MaintenanceRouteReason =
  | "model_not_required"
  | "team_semantic_service"
  | "team_haiku_service"
  | "preferred_economical_model"
  | "cheapest_compatible_model"
  | "explicit_strong_model"
  | "team_entitlement_required"
  | "pathrule_ai_disabled"
  | "user_engine_disabled"
  | "no_compatible_model"
  | "strong_approval_required";

export interface MaintenanceRouteDecision {
  available: boolean;
  tier: MaintenanceRouteTier | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  reason: MaintenanceRouteReason;
}

export type MaintenanceCapability =
  | "materializer"
  | "newUi"
  | "deterministicApply"
  | "pathruleAi"
  | "userEngine"
  | "knowledgeGapDelivery";

export type MaintenanceFeatureFlags = Record<MaintenanceCapability, boolean>;

/** What `MaintenanceAnalyzer.estimate` weighs for one task. */
export interface MaintenanceEstimateInput {
  taskKind: MaintenanceTaskKind;
  teamPlus: boolean;
  flags: MaintenanceFeatureFlags;
  explicitStrongApproval: boolean;
  candidates: readonly MaintenanceModelCandidate[];
  preferences: MaintenanceEnginePreferences;
}

// ─── The analysis contract's shapes ──────────────────────────────────────────

/** A detector's hit as a legacy suggestion, the finding adapter's input. */
export interface LegacySuggestionContext {
  suggestion: Suggestion;
  nodePath?: string | null;
  observedAt?: string;
}

/** A finding before the store gives it an id and its first and last sightings. */
export type MaintenanceFindingDraft = Omit<
  MaintenanceFinding,
  "id" | "firstSeenAt" | "lastSeenAt" | "resolvedAt"
> & {
  observedAt: string;
};

export interface SharedEvidenceCandidate {
  sourceKind: MaintenanceSourceKind;
  sourceId: string | null;
  locator: string;
  observedAt: string;
  contentHash: string;
  safeExcerpt: string | null;
  metadata: Record<string, unknown>;
  tokenEquivalent?: number;
  repositoryRule?: boolean;
  verified?: boolean;
  canonicalTeamEntryId?: string | null;
}

export interface PersonalizationCandidate {
  sourceKind: MaintenancePersonalizationSource;
  rankDelta: number;
  reason: string;
}

export interface BundledEvidenceItem extends SharedEvidenceCandidate {
  authority: number;
  tokenEquivalent: number;
}

export interface EvidenceBundle {
  items: BundledEvidenceItem[];
  tokenEquivalent: number;
  repoFiles: string[];
  dropped: {
    personal: number;
    unverifiedTeam: number;
    duplicate: number;
    itemLimit: number;
    tokenLimit: number;
    repoFileLimit: number;
    invalid: number;
  };
  fingerprint: string;
}

/** One case as the engine groups it, with the findings it holds and its bundled evidence. */
export interface MaintenanceCaseMaterial {
  caseDraft: Omit<MaintenanceCase, "id" | "firstSeenAt" | "lastSeenAt" | "resolvedAt" | "version">;
  findingIds: string[];
  evidence: BundledEvidenceItem[];
  evidenceBundle: EvidenceBundle;
}

export type MaintenanceContentKind = "memory" | "rule" | "skill";

/** A memory, rule or skill as a proposal is built against it; its hash is the precondition. */
export interface MaintenanceContentSnapshot {
  kind: MaintenanceContentKind;
  id: string;
  workspaceId: string;
  label: string;
  body: string;
  versionId: string;
  versionNumber: number;
  createdAt: string;
}

/** An allowlisted excerpt of a repository file, read by the host for a user-engine run. */
export interface RepoEvidenceExcerpt {
  locator: string;
  path: string;
  excerpt: string;
  contentHash: string;
  bytes: number;
}

/**
 * A user-engine prompt for one case. The host runs the model with `prompt` and asks it to answer in
 * `outputSchema`; everything else is the engine's, handed back to `validateOutput` unchanged.
 */
export interface MaintenancePrompt {
  prompt: string;
  outputSchema: Record<string, unknown>;
}

/** A model's proposal after validation, ready to publish. */
export interface MaintenanceProposalDraft {
  summary: string;
  operations: MaintenanceProposalOperation[];
  preconditionHashes: Record<string, string>;
}
