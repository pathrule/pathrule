// SPDX-License-Identifier: Apache-2.0
/**
 * KnowledgeBackend — the single seam between @pathrule/core's MCP tool surface
 * and its storage + intelligence layer.
 *
 *   LocalBackend  (open, SQLite) implements this for the self-hosted solo edition.
 *   The hosted edition implements the same contract over its own storage.
 *
 * The AI client sees an identical MCP tool contract regardless of which backend is
 * injected; only the optional capabilities (routeIntent / semanticCandidates) and the
 * `capabilities()` flags differ.
 *
 * Domain types (Memory/Rule/Skill, the intelligence result shapes, …) live in
 * @pathrule/shared and are imported here: @pathrule/shared is the lower, dependency-free
 * contracts layer that this package builds on. core imports shared; the dependency only
 * ever flows one way (enforced by the dependency guard).
 */
import type { ActivityLeadSource } from "../activity/activity-leads.js";
import type { LearningClaimStore } from "../project-learning/claims.js";
import type { Memory, Rule, Skill } from "@pathrule/protocol/content-types.js";
import type { RemedyAtom } from "@pathrule/agent-ir/atoms/remedy.js";
import type { CompiledMemoryDelivery } from "@pathrule/agent-ir/delivery/compiled-delivery.js";
import type { HookIndex } from "@pathrule/protocol/hook-index.js";
import type { AffinityPayload, EmbeddingsPayload, Warehouse, ContextScope, WriteMemoryInput, UpdateMemoryInput, ListMemoriesQuery, DeleteContentInput, DeleteContentResult, RestoreContentResult, WriteRuleInput, UpdateRuleInput, ListRulesQuery, WriteSkillInput, UpdateSkillInput, ListSkillsQuery, LogActivityInput, ActivityRecord, Activity, RecentActivitiesOptions, RequestRefreshInput, NodeDetailRecord, NodeRef, NodeContent, InvocationSkill, RelevantMemoryRow, RouteIntentInput, SemanticQuery, SemanticCandidatesResult, WorkspaceMatch, ClosestNode } from "./inputs.js";
// Type-only: erased at compile time, so referencing the node:crypto-backed
// hook-index module here adds no runtime dependency for browser consumers.
import type { HookIndexInput } from "./hook-index.js";
import type { CompiledKnowledgeNode, KnowledgeRenderMode } from "./knowledge-compiler.js";
import type { KnowledgeGapSummary, KnowledgeMapInput } from "./knowledge-map-input.js";
import type {
  ProjectMapSearchResult,
  HotPath,
  PriorSolution,
  NodeBrief,
  WorkEpisodeBrief,
  ResearchBriefing,
  AssembleBriefingInput,
  RecentActivityForRouter,
} from "@pathrule/protocol/intelligence-types.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";
import type { RoutingResult, SubtreeMemoryIndexResult } from "@pathrule/protocol/routing-types.js";
import type {
  RuntimeCorrectionInput,
  RuntimeCorrectionResult,
  RuntimeEventIndicator,
  RuntimeEventsPage,
  RuntimeEventsQuery,
  RuntimeEventsStatus,
} from "@pathrule/protocol/runtime-events.js";
import type { DedupCheckArgs, DedupCheckResult } from "@pathrule/protocol/dedup-types.js";
import type { MaterialisedNode } from "../tools/node-path.js";
import type { WorkspaceOverviewNode } from "../tools/overview.js";
import type {
  RefreshRow,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/protocol/refresh-types.js";
import type { BackendCapabilities } from "./capabilities.js";

export interface KnowledgeBackend extends LearningClaimStore {
  // ── lifecycle ──────────────────────────────────────────────────────────
  /** Whether the current session is still valid. LocalBackend: always true (single user). */
  sessionIsCurrent(): Promise<boolean>;

  // ── memory CRUD ────────────────────────────────────────────────────────
  readMemory(id: string): Promise<Memory | null>;
  writeMemory(input: WriteMemoryInput): Promise<Memory>;
  updateMemory(input: UpdateMemoryInput): Promise<Memory>;
  deleteMemory(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) memory to active. */
  restoreMemory(id: string): Promise<RestoreContentResult>;
  listMemories(query: ListMemoriesQuery): Promise<Memory[]>;

  // ── rule CRUD ──────────────────────────────────────────────────────────
  readRule(id: string): Promise<Rule | null>;
  /** Creates the rule and, when nodeId is supplied, attaches it to that node. */
  writeRule(input: WriteRuleInput): Promise<Rule>;
  /** Updates rule fields and, when nodeId is supplied, re-homes its node attachment. */
  updateRule(input: UpdateRuleInput): Promise<Rule>;
  deleteRule(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) rule to active. */
  restoreRule(id: string): Promise<RestoreContentResult>;
  listRules(query: ListRulesQuery): Promise<Rule[]>;

  // ── skill CRUD ─────────────────────────────────────────────────────────
  /** Returns the skill with its effective content — the backend resolves any package
   *  primary (SKILL.md) vs inline body internally, so callers get a usable body. */
  readSkill(id: string): Promise<Skill | null>;
  /** Creates the skill and, when nodeId is supplied, attaches it to that node. */
  writeSkill(input: WriteSkillInput): Promise<Skill>;
  /** Updates skill fields and, when nodeId is supplied, re-homes its node attachment. */
  updateSkill(input: UpdateSkillInput): Promise<Skill>;
  deleteSkill(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) skill to active. */
  restoreSkill(id: string): Promise<RestoreContentResult>;
  listSkills(query: ListSkillsQuery): Promise<Skill[]>;

  // ── workspace resolution ─────────────────────────────────────────────────
  /**
   * Resolve a cwd → workspace (longest local-root-path prefix). The hosted
   * edition resolves against the caller's registered workspace paths; the
   * self-hosted edition resolves from its local `workspaces` rows.
   * `null` ⇒ no workspace covers this path (handler surfaces a clean error).
   */
  resolveWorkspaceFromCwd(cwd: string): Promise<WorkspaceMatch | null>;
  /**
   * Walk up from a relative path to the closest node that exists (the workspace
   * root node has relative_path ""/"/"). `null` ⇒ the workspace has no nodes.
   */
  closestNode(workspaceId: string, relativePath: string): Promise<ClosestNode | null>;

  // ── tree ───────────────────────────────────────────────────────────────
  getTree(workspaceId: string): Promise<TreeNode[]>;
  /** A single node by id (access-scoped per edition). Used to resolve a content row's node path. */
  getNode(nodeId: string): Promise<TreeNode | null>;
  /** A node plus its directly-attached memory/rule/skill ids (backs the get_node tool). */
  getNodeDetail(nodeId: string): Promise<NodeDetailRecord | null>;
  /**
   * Every non-empty node in the workspace with its memory/rule/skill titles inline
   * (the llms.txt-style router index). semantic_tags are inferred when absent.
   */
  workspaceOverview(workspaceId: string, excludeNodeId?: string): Promise<WorkspaceOverviewNode[]>;
  /** Resolve a node by its exact workspace-relative path. */
  findNodeByPath(workspaceId: string, relativePath: string): Promise<NodeRef | null>;
  /** Raw memory/rule/skill content attached to a node (bodies included; handler shapes it). */
  getNodeContent(nodeId: string): Promise<NodeContent>;
  /** All active workspace skills with EFFECTIVE content, for ::skill-name invocation matching. */
  listSkillsForInvocation(workspaceId: string): Promise<InvocationSkill[]>;
  /** The first node a rule is attached to, or null if unattached. */
  getNodeForRule(ruleId: string): Promise<TreeNode | null>;
  /** The first node a skill is attached to, or null if unattached. */
  getNodeForSkill(skillId: string): Promise<TreeNode | null>;
  /**
   * Find or create the node chain for a workspace-relative path (path-first writes).
   * Missing ancestors materialise as folders; the leaf type is inferred unless given. Throws on failure.
   */
  ensureNodeForPath(
    workspaceId: string,
    path: string,
    leafType?: "folder" | "file" | "context",
  ): Promise<MaterialisedNode>;

  // ── write guards / dedup ─────────────────────────────────────────────────
  /** Read-only demo workspace (hosted edition only); false everywhere else. */
  isDemoWorkspace(workspaceId: string): Promise<boolean>;
  /** Normalised duplicate + fuzzy-similar pre-check for a memory/rule/skill title. */
  checkContentDedup(args: DedupCheckArgs): Promise<DedupCheckResult>;

  // ── context formulas (the get_context discovery + deep-briefing engine inputs) ──
  /**
   * Descendant memory titles for a path subtree. Returns the full result —
   * entries + truncated + total — that the get_context discovery surface
   * consumes. Empty scope path ("/") covers the whole workspace.
   */
  subtreeMemoryIndex(scope: ContextScope, limit: number): Promise<SubtreeMemoryIndexResult>;
  /**
   * Fuzzy "problem text → relevant content-bearing nodes" search. Ranks every
   * node carrying ≥1 memory/rule/skill by weighted trigram word-similarity
   * against its path/name/titles/body, keeping matches ≥ 0.30 (post-weight).
   * Returns ranked NodeBriefs (relevance 0–1, desc) + the top raw score.
   */
  projectMapSearch(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<ProjectMapSearchResult>;
  /**
   * Top-5 most-changed paths in the last 7 days. The hosted edition reads a
   * dedicated change feed; LocalBackend/InMemory derive from their own
   * `activity_logs` (populated by `logActivity`). Empty when there's no recent activity.
   */
  getHotPaths(workspaceId: string): Promise<HotPath[]>;
  /**
   * Snapshot the workspace-relative paths active when a memory was written, for later
   * prior-solutions ranking. The hosted edition reads its recent change feed;
   * LocalBackend/InMemory read their recent `activity_logs`. Best-effort —
   * callers fire-and-forget; a no-op when there's no recent activity.
   */
  recordMemoryContextPaths(memoryId: string, workspaceId: string): Promise<void>;
  /**
   * Top-N memories whose recorded context paths overlap `matchedPaths`, newest first.
   * Empty when matchedPaths is empty or nothing overlaps.
   */
  rankPriorSolutions(
    workspaceId: string,
    matchedPaths: string[],
    limit?: number,
  ): Promise<PriorSolution[]>;
  /**
   * Nodes that change together with the seeds. The hosted edition walks a
   * materialized co-change graph; LocalBackend/InMemory derive coupling on-read
   * from `activity_logs` (paths touched together in one activity). `changeLogCount`
   * tunes the hosted git/runtime blend; the local derivation ignores it. NodeBriefs
   * carry match_source "co_change" and relevance = min(1, weight/10); empty when
   * there are no seeds or no signal.
   */
  findCoupledNodes(
    workspaceId: string,
    seedNodeIds: string[],
    seedPaths: string[],
    changeLogCount: number,
  ): Promise<NodeBrief[]>;
  /**
   * Materialize/refresh work episodes from activity. The hosted edition upserts a
   * materialized table (throttled); LocalBackend/InMemory cluster on-read in
   * `searchWorkEpisodes`, so this is a no-op returning {ok:true, 0}.
   */
  refreshWorkEpisodes(
    workspaceId: string,
    since?: string,
  ): Promise<{ ok: boolean; episodes_upserted: number }>;
  /**
   * Episodes relevant to `query`, newest first. The hosted edition reads a
   * materialized table; LocalBackend/InMemory cluster `activity_logs`
   * deterministically (no LLM titles). `limit` is the caller's compact/deep budget.
   */
  searchWorkEpisodes(
    workspaceId: string,
    query: string,
    mode: "compact" | "deep",
    limit: number,
  ): Promise<WorkEpisodeBrief[]>;
  /**
   * Compose the deep-mode research briefing from the engine outputs. The backend
   * computes prior_solutions internally from the primary paths, dedups, ranks
   * suggested_order, and trims to budget.
   */
  assembleBriefing(input: AssembleBriefingInput): Promise<ResearchBriefing>;
  /**
   * UNION of node-owner (memories on the path's node + ancestors) and context-link memories
   * (memory_context_paths overlapping the path), node-owner winning duplicates. Each row
   * carries a `via` label for telemetry.
   */
  relevantMemoriesForPath(
    workspaceId: string,
    path: string,
    limit?: number,
  ): Promise<RelevantMemoryRow[]>;
  /**
   * The full offline hook-index payload: path memory/rule stubs, project rules,
   * recent subjects, session digest, filename + skill invocation indexes, work
   * episodes, refresh counts. LocalBackend/InMemory assemble it from their store
   * (hosted-only curation fields omitted). `workspace_root` is left empty for the
   * CLI writer to fill. Null only when unavailable.
   */
  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null>;

  /**
   * The full-body warehouse: every memory/rule/skill keyed by id, used for
   * delta delivery so the hook injects full bodies without an MCP round-trip.
   * Optional — backends that haven't adopted the warehouse simply omit it (the
   * writer then skips warehouse persistence). Built from the same source as the
   * hook index,
   * so `content_hash` values agree.
   */
  buildWarehousePayload?(workspaceId: string): Promise<Warehouse | null>;

  /**
   * The raw assembler input (memories/rules/skills with full bodies), for backends
   * that cannot run the assemblers themselves.
   *
   * A backend that cannot import node:crypto (where `assembleWarehouse` lives,
   * hook-index.ts) returns the DATA, and the Node-only hook-index writer runs the
   * assembler. A backend that implements `buildWarehousePayload` directly
   * (LocalBackend, in-memory) does not need this.
   */
  buildHookInputPayload?(workspaceId: string): Promise<HookIndexInput>;

  /**
   * Precomputed embedding vectors keyed by item id, persisted as
   * `embeddings.json` next to the warehouse so the hook can rank a routed path's
   * items against the prompt embedding offline. Optional — returns `null` when
   * no embedding key/store is wired (the hook then falls back to lexical
   * selection). The local edition projects its on-write embedding store with no
   * network; cloud/other backends may omit it.
   */
  buildEmbeddingsPayload?(workspaceId: string): Promise<EmbeddingsPayload | null>;

  /**
   * The vector space `buildEmbeddingsPayload`'s vectors are in (embeddingSpaceKey), stamped on the
   * hook index so the hook compares a prompt vector only with vectors of its own space. No network;
   * `null` when there are none. A backend without it gets no stamp, and the hook then ranks its
   * vectors against no local prompt vector at all.
   */
  embeddingSpace?(workspaceId: string): Promise<string | null>;

  /**
   * Learned per-memory affinity weights, persisted as `affinity.json` so the hook can
   * ORDER a routed path's candidates by proven usefulness as well as cosine similarity.
   * Optional — `null` when the backend has no affinity model (the local edition), and the
   * hook then ranks on similarity alone.
   *
   * It must never change WHETHER something is injected, only the order: the relevance
   * floor stays on the raw similarity. Letting a proven memory cross that floor would
   * grow the injected context, which is the opposite of the point.
   */
  buildAffinityPayload?(workspaceId: string): Promise<AffinityPayload | null>;

  /**
   * Native Knowledge Compilation: per-directory markdown
   * knowledge sections, compiled from the same source as the hook index, for
   * the client renderers to wrap in each agent's native instruction format
   * (directory CLAUDE.md, nested AGENTS.md, Cursor globs, Copilot applyTo).
   * Optional — when absent, companions stay protocol-only (legacy behavior).
   */
  buildKnowledgePayload?(
    workspaceId: string,
    mode?: KnowledgeRenderMode,
  ): Promise<CompiledKnowledgeNode[] | null>;

  /**
   * Memories delivered as their compiled form, keyed by memory id: for each memory whose approved
   * atoms the completeness gate judged a complete representation, the text that replaces its body.
   * The same plan the hook index is built from, for a surface that delivers memory bodies itself.
   * `memories`, when given, is the text the caller is about to deliver, and the gate judges against it.
   * Optional: a backend that keeps no atoms (the cloud edition) delivers every memory as written.
   */
  compiledMemoryDeliveries?(
    workspaceId: string,
    memories?: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<Record<string, CompiledMemoryDelivery>>;

  // ── activity ───────────────────────────────────────────────────────────
  /**
   * Persists an activity row and returns it. The hosted edition additionally stamps the
   * session/user, friction counts, and fires the applied-memory signal; LocalBackend
   * persists the core row only (friction + applied-memory are hosted-only intelligence).
   */
  logActivity(input: LogActivityInput): Promise<ActivityRecord>;
  /** Bounded, content-free activity evidence for project review priorities. */
  learningActivities?(workspaceId: string, limit?: number): Promise<ActivityLeadSource[]>;
  /**
   * The newest activities of the scope's workspace, newest first (insertion order breaks a tie);
   * with `options.since`, only those created at or after it.
   */
  recentActivities(
    scope: ContextScope,
    limit: number,
    options?: RecentActivitiesOptions,
  ): Promise<Activity[]>;
  /**
   * Recent activities in the get_context router/briefing shape (snake_case + node_path
   * + files_touched). The hosted edition filters by `userId`; LocalBackend ignores it
   * (single principal). Never throws — returns [] on any backend hiccup.
   */
  recentActivitiesForRouter(
    workspaceId: string,
    limit: number,
    userId?: string | null,
  ): Promise<RecentActivityForRouter[]>;

  // ── refresh queue (queue mechanics work locally; the AI brief populator is hosted-only) ──
  /** Open refresh tasks projected onto the summary shape. */
  listPendingRefreshes(
    workspaceId: string,
    includeInProgress?: boolean,
  ): Promise<PendingRefreshSummary[]>;
  /** Claim-on-read: a pending task transitions to in_progress and the full brief is returned. */
  getRefreshBrief(refreshId: string, claimedBy?: string): Promise<RefreshRow>;
  /**
   * Close a task. The hosted edition also mirrors the suggestion, writes a dismissal window,
   * and notifies the subject creator + admins; LocalBackend only flips the status.
   */
  resolveRefresh(
    refreshId: string,
    status: "applied" | "rejected",
    note?: string,
    claimedBy?: string,
  ): Promise<RefreshRow>;
  /** File a refresh against a concrete memory/rule subject. Idempotent per open subject. */
  requestRefresh(input: RequestRefreshInput): Promise<RequestRefreshResult>;

  // ── optional capabilities (return null when unsupported) ─────────────────
  /**
   * LLM intent router. Present only when a router LLM is reachable (the hosted
   * edition's service, or a bring-your-own `PATHRULE_AI_ROUTE_KEY` locally).
   * Returns a full RoutingResult (decision + fallback + latency_ms) so get_context
   * can degrade to the deterministic router on a fallback. `null` ⇒ capability not wired.
   */
  routeIntent?(input: RouteIntentInput): Promise<RoutingResult | null>;
  /**
   * Embedding-based memory retrieval for get_context's additive
   * `semantic_candidates` field. Present only when a vector store + embedding
   * key exist (the hosted edition's service, or a bring-your-own embedding key
   * locally). Returns the shaped payload + skip/latency the handler consumes;
   * `null` ⇒ capability not wired (field omitted, all other surfaces intact).
   */
  semanticCandidates?(query: SemanticQuery): Promise<SemanticCandidatesResult | null>;
  /**
   * Runtime events an application sent (Pathrule Local stores them; a Cloud backend reads its
   * own service). Optional: a backend without them has no runtime events, and the tools say so.
   * Content in a group is untrusted application data, never instructions.
   */
  listRuntimeEventGroups?(
    workspaceId: string,
    query?: RuntimeEventsQuery,
  ): Promise<RuntimeEventsPage | { error: string }>;
  /** Counts of current error groups under a path, for a context line; null when there are none. */
  runtimeEventIndicator?(workspaceId: string, path?: string): Promise<RuntimeEventIndicator | null>;
  runtimeEventStatus?(workspaceId: string): Promise<RuntimeEventsStatus>;
  /** A correction attempt on a group: compare-and-set on its revision, once per idempotency key. */
  recordRuntimeCorrection?(
    workspaceId: string,
    input: RuntimeCorrectionInput,
  ): Promise<RuntimeCorrectionResult>;
  /**
   * Everything the knowledge map needs in one read: live memories, rules and skills
   * with bodies and node paths, top-k vector neighbours for memories, and per-item session
   * counts (counts only, never session ids). Optional; a backend without it has no map and
   * the pathrule_knowledge_map tool says so.
   */
  buildKnowledgeMapInput?(workspaceId: string): Promise<KnowledgeMapInput | null>;
  /**
   * A cheap key that changes whenever buildKnowledgeMapInput would return different
   * items, bodies, attachments or vectors. The map cache is keyed on it, so it must be
   * read-only and fast (no bodies, no vectors).
   */
  knowledgeMapFingerprint?(workspaceId: string): Promise<string | null>;
  /**
   * Directory scopes a person dismissed as intentionally undocumented (rejected or
   * snoozed knowledge-gap cases, 180 days). Optional; backends without maintenance cases omit it.
   */
  knowledgeGapSuppressedScopes?(workspaceId: string): Promise<string[]>;
  /**
   * Open and recently closed knowledge-gap findings, for the map's atlas. Optional;
   * backends without maintenance findings omit it and the atlas shows no gaps line.
   */
  knowledgeGapSummary?(workspaceId: string): Promise<KnowledgeGapSummary | null>;

  /** Static description of what this backend can fill. */
  capabilities(): BackendCapabilities;
}

/**
 * Typed knowledge atoms that do not belong to a rule (see docs/architecture/decisions/0001).
 *
 * Deliberately NOT part of `KnowledgeBackend`. An atom is inferred by a model running on the
 * user's own machine over the user's own knowledge, and it stays there: the hosted backend must
 * not carry these methods, because carrying them is the same as offering to upload the evidence.
 * Splitting the interface makes that a compile-time fact rather than a convention someone has to
 * remember. A caller that needs atoms asks for a store that has them.
 */
export interface RemedyAtomStore {
  /**
   * Store a proposed atom, or return the one already stored for the same evidence.
   *
   * Idempotent by fingerprint on purpose: re-analysing the same memory must not mint a second
   * proposal, and an atom the user already REJECTED must not come back as pending. So an
   * existing row is returned untouched rather than overwritten.
   */
  proposeRemedyAtom(workspaceId: string, atom: RemedyAtom): Promise<RemedyAtom>;
  /** Atoms awaiting a decision, oldest first. The review queue's only read. */
  listProposedRemedyAtoms(workspaceId: string): Promise<RemedyAtom[]>;
  /** Every atom for one subject, whatever its status. */
  listRemedyAtomsForSubject(
    subjectType: "memory" | "rule",
    subjectId: string,
  ): Promise<RemedyAtom[]>;
  /**
   * Record a human decision. Approval is the ONLY transition that makes a remedy reusable, and
   * it neither executes it nor touches its evidence.
   */
  decideRemedyAtom(
    workspaceId: string,
    atomId: string,
    decision: "approve" | "reject",
    decidedBy: string,
  ): Promise<RemedyAtom>;
}

/** A backend that also keeps inferred atoms: the local store, and the in-memory test double. */
export type LocalKnowledgeBackend = KnowledgeBackend & RemedyAtomStore;
