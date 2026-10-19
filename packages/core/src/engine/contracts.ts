// SPDX-License-Identifier: Apache-2.0
/**
 * The shapes an engine in the slot (registry.ts) implements. Open code no longer reads the slot, so
 * these are kept for the composition that still type-checks against them (Pathrule Cloud) and for
 * the undistributed Engine package; open code imports only `PersonalEntriesConfig` and
 * `PersonalStoreBinding` from here.
 *
 * These live beside `KnowledgeBackend`, which they name, and move to @pathrule/protocol with it.
 */
import type { GuidanceEntry } from "@pathrule/protocol/guidance-types.js";
import type { FailPatternStub, FailureEvent, KnowledgeGapStub } from "@pathrule/protocol/hook-index.js";
import type {
  ConditionObservation,
  DeliveredAdvisory,
  ObservedEvent,
  OutcomeVerdict,
  UsageAttribution,
} from "@pathrule/protocol/outcome-types.js";
import type {
  ProactiveSignal,
  RelatedPathRow,
  RelevantEpisode,
} from "@pathrule/protocol/retrieval-rows.js";
import type { ProjectFingerprint, SeedSuggestion } from "@pathrule/protocol/project-fingerprint.js";
import type { FormulaId, FormulaRunOutput, FormulaSchedule } from "@pathrule/protocol/suggestions.js";
import type {
  LegacySuggestionContext,
  MaintenanceCaseDetail,
  MaintenanceCaseMaterial,
  MaintenanceContentKind,
  MaintenanceContentSnapshot,
  MaintenanceEstimate,
  MaintenanceEstimateInput,
  MaintenanceFinding,
  MaintenanceFindingDraft,
  MaintenanceModelEntry,
  MaintenancePrompt,
  MaintenanceProposal,
  MaintenanceProposalDraft,
  MaintenanceTask,
  MaintenanceTaskKind,
  RepoEvidenceExcerpt,
} from "@pathrule/protocol/maintenance.js";
import type {
  ActivityQuery,
  ActivityRow,
  DuplicateMemoryPair,
  GitChangeSet,
  GitCheckpoint,
  GitCommitActivity,
  GitRepositorySnapshot,
  KnowledgeQuery,
  KnowledgeRow,
  LearningClaimRow,
  TitlePairCandidate,
  TitlePairVerdict,
  WorkspaceEntry,
  WorkspaceEntryKind,
} from "@pathrule/protocol/workspace-read.js";
import type { ContextDepth, RoutingResult } from "@pathrule/protocol/routing-types.js";
import type { SessionAttribution } from "@pathrule/protocol/session-attribution.js";
import type {
  CommitWisdomResult,
  DocumentationSynthesisOptions,
  DocumentationSynthesisResult,
} from "@pathrule/protocol/setup-brief.js";

import type { RouteIntentInput } from "../backend/inputs.js";
import type { KnowledgeBackend, RemedyAtomStore } from "../backend/knowledge-backend.js";
import type { KnowledgeMap } from "../knowledge-map/types.js";
import type { LearningClaim } from "../project-learning/claims.js";
import type { ClaimCurrency } from "../project-learning/claim-service.js";
// The open shapes of a person's knowledge and its hook-index lines (they move to core in 2e).
import type { UserPreferenceEntry } from "../user-knowledge/user-delivery.js";
import type { UserEvidenceKind, UserEvidenceSurface, UserKnowledgeAtom } from "../user-knowledge/user-knowledge.js";
import type { UserKnowledgeStore } from "../user-knowledge/user-knowledge-persistence.js";

/**
 * Routes a get_context intent with a model. Open default: none, so the deterministic router answers.
 */
export interface IntentRouter {
  /** A decision, a soft fallback, or `null` when this router is not configured. Never throws. */
  route(input: RouteIntentInput): Promise<RoutingResult | null>;
  /** Whether `route` can answer at all; drives `capabilities().routerLLM`. */
  available(): boolean;
}

/** Whether a turn was solved from its context or fell into exploring the repository. */
export type ContextSufficiency = "sufficient" | "explored" | "unknown";

/** One turn's tool stream, as the host tallied it. */
export interface ContextSufficiencyInput {
  /** Read-only discovery calls: the agent hunting through the repository. */
  exploreCalls: number;
  /** File-writing calls. Kept for the rubric's definition (a result turn edits); not gated on. */
  editCalls: number;
  /** Injected memories the agent applied this turn: the positive signal. */
  appliedMemoryCount: number;
  /** File count of the workspace, when known; it scales the exploration budget. */
  workspaceSize?: number;
  /**
   * False when no tool stream was observed: the turn is `unknown` and stays out of the rate's
   * denominator, so the number is never flattered.
   */
  hasToolStream: boolean;
}

/**
 * Reads one file of a workspace for the engine: a workspace-relative path in; its text, `null` when the
 * file is gone, `undefined` when it must not or cannot be read (outside the workspace, through a link
 * that leaves it, too large, not a file). The host decides what may be read; the engine never opens a
 * file of the person's itself.
 */
export type WorkspaceFileReader = (relativePath: string) => Promise<string | null | undefined>;

/** One file an agent changed in a turn, with what every tool call on it carried. */
export interface EditedFile {
  /** Workspace-relative, `/`-separated. */
  path: string;
  /** Whether any of the turn's calls created it. */
  created: boolean;
  /** The calls' patches, in order; `undefined` where a call carried none. */
  patches: readonly (string | undefined)[];
}

/** An agent turn's changes, to be observed before the person's next turn in the same workspace. */
export interface EditEpisodeCapture {
  /** The workspace's canonical root: episodes are kept and taken by it. */
  workspaceKey: string;
  threadId: string;
  /** The prompt that started the turn; it places the episode in high-risk domains. */
  taskText: string;
  /** One entry per file, in the order the turn first changed them. */
  files: readonly EditedFile[];
  read: WorkspaceFileReader;
}

/** What became of one captured episode's files. Opaque to the host past its thread. */
export interface EditEpisodeObservation {
  readonly threadId: string;
}

/**
 * The workspace id a learned outcome is recorded under. The engine asks only when it has one to record;
 * `null` records nothing.
 */
export type LearningWorkspace = () => Promise<string | null>;

/** A decision card's options, as the surface that showed the card parsed them. */
export interface DecisionCardChoice {
  options: readonly { id: string; label: string; tags: readonly string[] }[];
  recommended: string | null;
}

/** Who and when, for the evidence the engine keeps about a person; where it reports a failed write. */
export interface LearningConfig extends PersonalEntriesConfig {
  log?: (message: string) => void;
}

/** One thing the person said, during their work or to teach Pathrule, as the surface observed it. */
export interface UserMessageObservation {
  surface: UserEvidenceSurface;
  /** The words came from speech recognition: a machine's guess at what was said. */
  transcribed: boolean;
  /** What the person wrote: the only text a belief may be grounded in. */
  userText: string;
  /** What the agent had just said, for intelligibility only. */
  agentText: string | null;
  /** A reply to an agent is a correction; a subject the person opened is teaching. */
  kind: UserEvidenceKind;
  workspaceId: string | null;
  /** The conversation it was said in; null for a place made for teaching (Settings, the CLI). */
  threadId: string | null;
  messageId: string;
  observedAt: string;
  /**
   * The person was teaching Pathrule on purpose, not talking to an agent about the work. Absent means a
   * work conversation; only a teaching may become EXPLICIT.
   */
  taught?: boolean;
}

export type UserMessageConfig = PersonalEntriesConfig;

/** What one observation came to. Only `stored` changed what is known about the person. */
export type UserMessageOutcome =
  /** `promoted`: the belief became active with this observation, the one moment worth telling a person. */
  | { status: "stored"; atom: UserKnowledgeAtom; promoted: boolean }
  | { status: "nothing_learned"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Decides what Pathrule learns from how work goes: what an agent's tool events say about the knowledge
 * delivered to it, whether a turn needed to explore, which failures recur, and what the person's words,
 * their edits to an agent's work and their picks among offered options say about them. The host and
 * the backend capture and store the raw events; the observer decides and keeps its own evidence about
 * the person. Open default: none, so nothing is attributed, judged, promoted, learned or recorded.
 */
export interface LearningObserver {
  attributeUsage(delivered: DeliveredAdvisory[], event: ObservedEvent): UsageAttribution[];
  observeCondition(advisory: DeliveredAdvisory, event: ObservedEvent): ConditionObservation;
  classifyCommandOutcome(attribution: UsageAttribution, exitCode: number | null): OutcomeVerdict;
  classifyCheckOutcome(
    attribution: UsageAttribution,
    transition: { was_failing: boolean; now_passing: boolean } | null,
  ): OutcomeVerdict;
  classifyErrorPersistenceOutcome(
    attribution: UsageAttribution,
    conditionSignature: string | null,
    laterOutput: string | null,
  ): OutcomeVerdict;
  /**
   * Note that the agent read a record by id: a relevance label nobody had to ask for. Never throws,
   * because losing a label must not fail the read it rides on.
   */
  recordKnowledgePull(id: string, kind: "memory" | "rule" | "skill"): Promise<void>;
  /** What the hook delivered to one session, read once: the record is consumed. Null when none. */
  drainSessionAttribution(workspaceId: string, sessionId: string): SessionAttribution | null;
  /** Whether one turn was solved from its context. Open default: `unknown`. */
  classifyContextSufficiency(input: ContextSufficiencyInput): ContextSufficiency;
  /**
   * The failures that recur enough to warn the next agent about, most recent first, from one
   * workspace's recent failure events. Open default: none.
   */
  promoteFailurePatterns(events: readonly FailureEvent[]): FailPatternStub[];
  /** Edits: keep an agent turn's changes as a pending episode, reading the files through the host. */
  captureEditEpisode(input: EditEpisodeCapture, cfg: LearningConfig): Promise<void>;
  /**
   * Edits: take a workspace's pending episodes and read what became of their files. The host runs this
   * inside its read budget, before the next agent can touch them, and drops the result when it is late.
   */
  takeEditEpisodes(
    input: { workspaceKey: string; read: WorkspaceFileReader },
    cfg: LearningConfig,
  ): Promise<EditEpisodeObservation[]>;
  /** Edits: learn from what `takeEditEpisodes` saw. Resolves once every write has settled. */
  learnFromEditEpisodes(
    observations: readonly EditEpisodeObservation[],
    workspace: LearningWorkspace,
    cfg: LearningConfig,
  ): Promise<void>;
  /** Picks: learn from the person's reply to a decision card, when it picks one of its options. */
  learnFromDecisionPick(
    input: { card: DecisionCardChoice; userText: string; threadId: string },
    workspace: LearningWorkspace,
    cfg: LearningConfig,
  ): Promise<void>;
  /**
   * Words: learn from one thing the person said, with the model the host opened. Never throws for a
   * missing or failing model: that is `unavailable`, and nothing is learned.
   */
  observeUserMessage(
    observation: UserMessageObservation,
    cfg: UserMessageConfig,
  ): Promise<UserMessageOutcome>;
}

/** One semantic candidate, as the ranker sees it. Ranks are 1-based. */
export interface SemanticRankInput {
  id: string;
  /** Position in the similarity order. */
  semantic_rank: number;
  /** Position in the lexical surface; absent when the candidate is not on it. */
  lexical_rank?: number;
  /** Learned affinity of this record to the query's intent; null when none was learned. */
  affinity_decayed_weight: number | null;
}

/**
 * Orders and budgets what get_context returns beyond the deterministic surfaces. Open default: none,
 * so semantic candidates keep their similarity order, no work episodes are surfaced and no
 * proactive signal is derived.
 */
export interface ContextRanker {
  /**
   * Candidate ids in their fused order, or null when no candidate carries a learned signal and the
   * similarity order stands.
   */
  rerankSemanticCandidates(candidates: SemanticRankInput[]): string[] | null;
  /** How many relevant work episodes one answer may carry; 0 skips them. */
  episodeBudget(taskShape: string, depth: ContextDepth, workspaceId: string): number;
  /** Episodes (best first) cut to the episode token budget, and the estimate of what is left. */
  trimEpisodes(episodes: RelevantEpisode[]): { episodes: RelevantEpisode[]; tokenEstimate: number };
  /** The directive a set of co-change related paths implies, if any. */
  proactiveSignal(input: {
    workspaceId: string;
    primaryPath: string | null;
    relatedPaths: RelatedPathRow[] | undefined;
    depth: ContextDepth;
  }): ProactiveSignal | undefined;
}

/** Who and when, for the person-scoped parts of a contribution. */
export interface PersonalEntriesConfig {
  env?: NodeJS.ProcessEnv;
  /** Resolved account id, or null in the no-account local edition. */
  userId?: string | null;
  now?: () => string;
  /**
   * Where the person's beliefs are kept, opened by the host for one identity. Absent: the local
   * file of `userId` (`createFileUserKnowledgeStore`), which is the default everywhere. A store bound
   * to an account comes only from an explicit, authorized mapping; this seam never moves local
   * beliefs into one.
   */
  userKnowledge?: UserKnowledgeStore;
}

/**
 * The signed-in person's account id and belief store for one workspace, as a composition resolved
 * them for an identity it authenticated through an explicit workspace mapping. Spread into a
 * `PersonalEntriesConfig`; absent means the no-account person's local file.
 */
export interface PersonalStoreBinding {
  userId: string;
  userKnowledge: UserKnowledgeStore;
}

/** One turn, as the person's guidance is selected for it. */
export interface TurnGuidanceTask {
  /** The turn's text. */
  text: string;
  workspaceId: string | null;
  /** The workspace path the turn runs at. */
  path?: string | null;
  /** The workspace's root on disk. No root, no expertise leases. */
  workspaceRoot?: string | null;
  /** Other names for this workspace (its registered root), so a belief recorded by path finds it. */
  workspaceAliases?: readonly (string | null | undefined)[];
}

export interface TurnGuidanceConfig extends PersonalEntriesConfig {
  /** The person's setting for asking agents to check a library's docs first. Absent means allowed. */
  leaseRequests?: boolean;
}

/**
 * Adds engine-decided fields to the hook index and sections to a turn's context. Open default:
 * none, so the fields and sections are absent.
 */
export interface ContextContributor {
  /** Open knowledge gaps for the index; empty when there are none or gap delivery is off. */
  knowledgeGapsForIndex(input: {
    backend: KnowledgeBackend;
    workspaceId: string;
    workspaceRoot: string;
    env: NodeJS.ProcessEnv;
  }): Promise<KnowledgeGapStub[]>;
  /**
   * The person's preference and guidance lines for one workspace's index, and whose they are:
   * `personalOwner` is `cfg.userId` when the entries come from an account's store, null for the
   * accountless local file. Spread into the index writer, it stamps the entries with their owner.
   */
  personalIndexEntries(
    workspaceId: string,
    workspaceRoot: string | null,
    cfg: PersonalEntriesConfig,
  ): Promise<{ userPreferences: UserPreferenceEntry[]; guidance: GuidanceEntry[]; personalOwner?: string | null }>;
  /**
   * How the person works, selected for one turn and rendered: their preferences, the oversight
   * they asked for and the expertise leases that apply. Empty text when there is nothing to say.
   */
  turnGuidance(task: TurnGuidanceTask, cfg: TurnGuidanceConfig): Promise<{ text: string }>;
}

/**
 * Holds a stored belief about a person to today's rules when it is read. It only ever withholds.
 * Open default: none, so a belief is read as it was stored.
 */
export interface UserKnowledgeJudge {
  regate(atom: UserKnowledgeAtom): UserKnowledgeAtom;
}

/** The slice of a store REMEDY analysis reads memories from and proposes atoms through. */
export type RemedyAnalysisStore = Pick<KnowledgeBackend, "readMemory"> &
  Pick<RemedyAtomStore, "proposeRemedyAtom" | "listRemedyAtomsForSubject">;

export interface RemedyAnalysisInput {
  store: RemedyAnalysisStore;
  /** The memories to read, in order. The engine reads at most its own bound of them. */
  memoryIds: readonly string[];
  now: string;
}

/** What one REMEDY batch did. A failure is reported per memory, never counted as "nothing found". */
export interface RemedyAnalysisBatch {
  analyzed: number;
  /** Atoms this batch proposed, each awaiting a person's decision. */
  proposed: number;
  /** Memories that already carry an atom, decided or still pending. */
  skipped: number;
  noRemedy: number;
  /** How each answer was parsed. Salvage must stay a rare emergency path, not the parser. */
  parseModes: { json: number; salvage: number; failed: number };
  failures: Array<{ memoryId: string; kind: string; message: string }>;
}

/**
 * Produces knowledge proposals; a person reviews every one before it becomes knowledge. Open
 * default: none, so nothing is proposed: the setup brief keeps its stack signals and activity leads,
 * REMEDY analysis does not run, and a project scan suggests no seeds.
 */
export interface KnowledgeProducer {
  /** Memory and rule candidates from the repository's documentation. */
  synthesizeDocumentation(root: string, options?: DocumentationSynthesisOptions): Promise<DocumentationSynthesisResult>;
  /** Risk hotspots from the risky commits of a `git log` the caller read. */
  commitWisdom(gitLogOutput: string): CommitWisdomResult;
  /** REMEDY: corrective knowledge in the named memories, proposed through the store as atoms. */
  analyzeRemedies(input: RemedyAnalysisInput): Promise<RemedyAnalysisBatch>;
  /** Seed memories for a project a surface opens for the first time, from its fingerprint. */
  suggestSeeds(fingerprint: ProjectFingerprint): SeedSuggestion[];
  /**
   * A model-free proposal for a maintenance case: high-precision update and archive operations,
   * or an explicit no change, each target with its precondition hash. A person approves it before
   * the host applies anything.
   */
  proposeMaintenance(
    detail: MaintenanceCaseDetail,
    readSnapshot: MaintenanceSnapshotReader,
  ): Promise<{ proposal: MaintenanceProposal; targetIds: string[] }>;
}

/** Git, read-only, at the workspace's root. */
export interface WorkspaceGit {
  /** HEAD, its branch and the default branch. Throws outside a checkout. */
  snapshot(): Promise<GitRepositorySnapshot>;
  /** The files that changed between two commits. Throws on a malformed range or a failed read. */
  changes(baseSha: string, headSha: string): Promise<GitChangeSet>;
  /** Commits of the last `windowDays` with the paths they touched; [] on any failure. */
  activity(windowDays: number): Promise<GitCommitActivity[]>;
}

/**
 * The workspace's files, read-only. Paths are relative to the root; a path that leaves the root
 * reads as absent.
 */
export interface WorkspaceFiles {
  /** What the path is, following symbolic links, or null when absent or unreadable. */
  stat(path: string): Promise<WorkspaceEntryKind | null>;
  /** The directory's entries, or null when it cannot be read. */
  list(path: string): Promise<WorkspaceEntry[] | null>;
  /** The file as UTF-8, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Whether a claim's sources still match the working tree. */
  verifyLearningSources(sources: LearningClaim["sources"]): Promise<ClaimCurrency>;
}

/**
 * What an engine may read of one workspace, provided by the host. Each method is a read
 * a maintenance detector makes; there is no write method, so every change the engine wants goes
 * back to a person as a proposal. A read throws where its failure must fail the detector, and
 * otherwise answers empty, as the store's own read does.
 */
export interface WorkspaceReadPort {
  /** Active memories. */
  memories(query: KnowledgeQuery): Promise<KnowledgeRow[]>;
  /** Active rules (a rule's `title` is its name). */
  rules(query: KnowledgeQuery): Promise<KnowledgeRow[]>;
  /** How many memories are active. Throws when the store cannot say. */
  memoryCount(): Promise<number>;
  /** The newest activity entries. */
  activity(query: ActivityQuery): Promise<ActivityRow[]>;
  /** How many context injections were recorded since `since`; null when unknown. */
  injectionsSince(since: string): Promise<number | null>;
  /** When an item was last injected, or null. */
  lastInjection(kind: "memory" | "rule", id: string): Promise<string | null>;
  /** Memory pairs whose stored vectors are nearly identical. Throws when the lookup fails. */
  duplicateMemoryPairs(): Promise<DuplicateMemoryPair[]>;
  /** The workspace's knowledge map. Throws when it cannot be built. */
  knowledgeMap(): Promise<KnowledgeMap>;
  /** The newest recorded learning claims. Throws when they cannot be read. */
  learningClaims(limit: number): Promise<LearningClaimRow[]>;
  /** Directory scopes a person dismissed as intentionally undocumented. Throws on a failed read. */
  suppressedGapScopes(): Promise<string[]>;
  /** How far Git impact has read this branch, or null before its first read. */
  gitCheckpoint(branch: string): Promise<GitCheckpoint | null>;
  git: WorkspaceGit;
  files: WorkspaceFiles;
}

/**
 * Pathrule's hosted adjudication of title pairs (a Cloud call, not a read). Null: no signed-in
 * session. The caller sends each pair as two consecutive candidates.
 */
export type TitlePairJudge = (input: {
  workspaceId: string;
  candidates: TitlePairCandidate[];
}) => Promise<TitlePairVerdict[] | null>;

export interface MaintenanceScanInput {
  formulaId: FormulaId;
  workspaceId: string;
  read: WorkspaceReadPort;
  judgeTitlePairs?: TitlePairJudge;
}

/** How the engine reads a proposal's targets: the content as the host will write it. */
export type MaintenanceSnapshotReader = (
  kind: MaintenanceContentKind,
  id: string,
) => Promise<MaintenanceContentSnapshot | null>;

/**
 * Knowledge Maintenance's analysis. The host schedules, stores, gates, runs the person's own model
 * and applies; the engine detects, groups, routes, writes the prompt and checks the answer. Open
 * default: none, so no detector runs, no case is made and no route is available.
 */
export interface MaintenanceAnalyzer {
  /** Every detector the engine knows, in its order, with its cadence. */
  formulas(): readonly FormulaSchedule[];
  /** One detector over the workspace. Its failure is thrown, never reported as a clean run. */
  scan(input: MaintenanceScanInput): Promise<FormulaRunOutput>;
  /** A detector's hits as finding drafts, one per hit. */
  draftFindings(inputs: readonly LegacySuggestionContext[]): MaintenanceFindingDraft[];
  /** The cases active findings make: grouping, bundled evidence, confidence and fingerprint. */
  materialize(input: { findings: readonly MaintenanceFinding[] }): MaintenanceCaseMaterial[];
  /** What a task kind needs. */
  task(kind: MaintenanceTaskKind): MaintenanceTask;
  /** The route and the hard budget of one task. */
  estimate(input: MaintenanceEstimateInput): MaintenanceEstimate;
  /** The models each agent CLI offers, by agent id. */
  modelTable(): Readonly<Record<string, readonly MaintenanceModelEntry[]>>;
  /** The user-engine prompt for a case, its targets read through `readSnapshot`. */
  buildPrompt(input: {
    detail: MaintenanceCaseDetail;
    taskKind: MaintenanceTaskKind;
    repoEvidence: readonly RepoEvidenceExcerpt[];
    readSnapshot: MaintenanceSnapshotReader;
  }): Promise<MaintenancePrompt>;
  /** The model's answer checked against its prompt. Throws a named code when it is unsafe. */
  validateOutput(input: {
    value: unknown;
    prompt: MaintenancePrompt;
    taskKind: MaintenanceTaskKind;
  }): MaintenanceProposalDraft;
}

/** Everything an installed engine provides. Each part is optional and defaults independently. */

export interface EngineParts {
  intentRouter?: IntentRouter;
  learningObserver?: LearningObserver;
  contextRanker?: ContextRanker;
  contextContributor?: ContextContributor;
  userKnowledgeJudge?: UserKnowledgeJudge;
  knowledgeProducer?: KnowledgeProducer;
  maintenanceAnalyzer?: MaintenanceAnalyzer;
}
