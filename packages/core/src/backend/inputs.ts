// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical input / auxiliary contract types owned by @pathrule/core.
 * Every backend implements KnowledgeBackend against these, so the contract —
 * not a storage client — is the source of truth.
 */

import type { ActivityProvenance } from "../activity/activity-leads.js";
import type { RuleAtom } from "@pathrule/agent-ir/atoms/atoms.js";
import type { KnowledgeOrigin } from "@pathrule/protocol/content-types.js";

/** A path within a workspace — the scope most context calls resolve against. */
export interface ContextScope {
  workspaceId: string;
  relativePath: string;
}

/**
 * One full-body warehouse entry. The matching hook-index carries only
 * stubs + content_hash; the warehouse carries the bodies, addressable by id,
 * read selectively for delta delivery. `content_hash` matches the index's.
 */
export interface WarehouseEntry {
  type: "memory" | "rule" | "skill";
  title: string;
  body: string;
  content_hash: string;
  /**
   * Memory delivered as its compiled form: the atom refs that form is made of. The hook skips the body
   * when these refs already reached the session as advisories, and records them when the body ships.
   */
  compiled_refs?: string[];
}

/** The full-body warehouse: every memory/rule/skill keyed by id. */
export type Warehouse = Record<string, WarehouseEntry>;

/**
 * Precomputed embedding vectors keyed by item id (memory; skills later).
 * Written next to the warehouse as `embeddings.json` so the hook can rank a
 * routed path's items against the prompt embedding with no network at index
 * time. Produced by KnowledgeBackend.buildEmbeddingsPayload; absent ⇒ the hook
 * falls back to lexical selection (no key / no store).
 */
export type EmbeddingsPayload = Record<string, number[]>;

/**
 * Learned affinity weight per memory id, 0..1, persisted as `affinity.json` next to
 * embeddings.json so the HOOK can use it.
 *
 * Why it exists: the affinity model was read in exactly one place — the MCP server's
 * semantic-candidate ranker — while the hook, which delivers most of Pathrule's
 * knowledge, never saw it (measured 2026-08-22: the string "affinity" does not appear in
 * pathrule-hook.js). So the loop could close and still change nothing about what the
 * agent gets shown.
 *
 * The value is the MAX decayed weight across that memory's intent clusters: "this memory
 * has proven useful for at least one kind of ask". Cluster-aware weighting would be more
 * precise and needs the centroids on disk; that is a separate step, deliberately not
 * bundled with this one so the ranking change can be measured on its own.
 */
export type AffinityPayload = Record<string, number>;

// ── Memory ────────────────────────────────────────────────────────────────
export interface WriteMemoryInput {
  workspaceId: string;
  /**
   * Client-owned row id. Supplying it makes the write IDEMPOTENT, which is what lets a
   * write be queued while a remote store is unreachable: the record needs an identity
   * BEFORE the store sees it, so the local copy and the eventual remote row are the same
   * record rather than two. Omit it and the backend mints one.
   */
  id?: string;
  nodeId?: string;
  title: string;
  content: string;
  source?: "claude" | "manual";
  /**
   * Secondary context links: workspace paths the memory is also relevant to. Never a second
   * owner; `nodeId` stays the one owner. Omitted keeps the stored links (none for a new row).
   * Validated and canonicalised by `normalizeRelatedPaths` (backend/memory-links.ts).
   */
  relatedPaths?: string[];
  /** Where a copied item came from (`KnowledgeOrigin`). Stored on create; later edits keep it. */
  origin?: KnowledgeOrigin;
  /**
   * With `id`: create only. An item that already has this id comes back as it is, never
   * updated, so running a copy again cannot overwrite an edit made since the first run.
   */
  ifAbsent?: boolean;
}
export interface UpdateMemoryInput {
  id: string;
  /**
   * Optimistic guard. A mismatched current version must not be overwritten: the body, the
   * owner and the links change together or not at all.
   */
  expectedVersionId?: string;
  title?: string;
  content?: string;
  /** Re-home the memory to a different node (the move_to_path target, already resolved). */
  nodeId?: string;
  /** Secondary context links: omitted keeps them, `[]` clears them, a list replaces them. */
  relatedPaths?: string[];
}
export interface ListMemoriesQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Delete (shared by memory/rule/skill) ─────────────────────────────────────
export interface DeleteContentInput {
  id: string;
  /** Hard delete (purge) vs the default soft delete (archive). */
  hard?: boolean;
  /** Optimistic concurrency token — a soft delete conflicts if it no longer matches. */
  expectedVersionId?: string;
}
/** Discriminated delete outcome so callers map to their own error contract without throwing. */
export type DeleteContentResult =
  | { status: "deleted"; id: string; workspaceId: string; nodeId: string | null }
  | { status: "conflict"; currentVersionId: string }
  | { status: "rejected"; reason: string };

/**
 * Discriminated restore outcome (archived → active). `reason` carries a stable error
 * string ("not_found" | "not_deleted" | "forbidden" | …) the handler maps to its error contract.
 */
export type RestoreContentResult =
  | { status: "restored"; id: string; workspaceId: string; nodeId: string | null }
  | { status: "rejected"; reason: string };

// ── Rule ──────────────────────────────────────────────────────────────────
export interface WriteRuleInput {
  workspaceId: string;
  /**
   * Client-owned row id. Supplying it makes the write IDEMPOTENT, which is what lets a
   * write be queued while a remote store is unreachable: the record needs an identity
   * BEFORE the store sees it, so the local copy and the eventual remote row are the same
   * record rather than two. Omit it and the backend mints one.
   */
  id?: string;
  nodeId?: string;
  name: string;
  content: string;
  scopeType: "folder" | "file_type" | "project";
  priority?: "high" | "medium" | "low";
  /**
   * Executable CONSTRAINT atoms, already validated and stamped by the caller. The
   * backend stores them verbatim: it is not the place that decides authority.
   */
  constraints?: RuleAtom[];
  /** Where a copied item came from (`KnowledgeOrigin`). Stored on create; later edits keep it. */
  origin?: KnowledgeOrigin;
  /**
   * With `id`: create only. An item that already has this id comes back as it is, never
   * updated, so running a copy again cannot overwrite an edit made since the first run.
   */
  ifAbsent?: boolean;
}
export interface UpdateRuleInput {
  id: string;
  /** Optional optimistic guard. A mismatched current version must not be overwritten. */
  expectedVersionId?: string;
  name?: string;
  content?: string;
  scopeType?: "folder" | "file_type" | "project";
  priority?: "high" | "medium" | "low";
  /** Re-home the rule's node attachment (the move_to_path target, already resolved). */
  nodeId?: string;
  /** Replaces the stored constraint list when present; omit to leave it untouched. */
  constraints?: RuleAtom[];
}
export interface ListRulesQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Skill ─────────────────────────────────────────────────────────────────
export interface WriteSkillInput {
  workspaceId: string;
  /**
   * Client-owned row id. Supplying it makes the write IDEMPOTENT, which is what lets a
   * write be queued while a remote store is unreachable: the record needs an identity
   * BEFORE the store sees it, so the local copy and the eventual remote row are the same
   * record rather than two. Omit it and the backend mints one.
   */
  id?: string;
  nodeId?: string;
  name: string;
  content: string;
  description?: string | null;
  source?: "manual" | "template" | "github_ref";
  githubUrl?: string | null;
  tags?: string[];
  /** Where a copied item came from (`KnowledgeOrigin`). Stored on create; later edits keep it. */
  origin?: KnowledgeOrigin;
  /**
   * With `id`: create only. An item that already has this id comes back as it is, never
   * updated, so running a copy again cannot overwrite an edit made since the first run.
   */
  ifAbsent?: boolean;
}
export interface UpdateSkillInput {
  id: string;
  /** Optional optimistic guard. A mismatched current version must not be overwritten. */
  expectedVersionId?: string;
  name?: string;
  content?: string;
  /** null clears the description; undefined keeps it. */
  description?: string | null;
  source?: "manual" | "template" | "github_ref";
  /** null clears the URL; undefined keeps it. */
  githubUrl?: string | null;
  tags?: string[];
  /** Re-home the skill's node attachment (the move_to_path target, already resolved). */
  nodeId?: string;
}
export interface ListSkillsQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Activity ────────────────────────────────────────────────────────────────
/** Structured file inventory for an activity (the `files_touched` shape). */
export interface FilesTouchedInput {
  total: number;
  by_area: Record<string, string[]>;
}
/**
 * Friction counts (tool call/failure telemetry). Persisted only by the hosted edition,
 * which enforces failures ≤ calls and code shape; LocalBackend ignores them — friction
 * telemetry is a hosted-only intelligence surface.
 */
export interface ActivityFriction {
  toolCallCount?: number;
  toolFailureCount?: number;
  toolFailureCodes?: string[];
}
export interface ActivityTeamIntelligenceSignal {
  score: number;
  category:
    | "architecture"
    | "coding_style"
    | "debugging"
    | "design"
    | "testing"
    | "review"
    | "planning"
    | "release"
    | "security"
    | "collaboration"
    | "ai_usage"
    | "other";
  surface: "chat" | "tasks";
}
export interface LogActivityInput {
  provenance?: ActivityProvenance;
  workspaceId: string;
  nodePath?: string;
  domain: string;
  action: string;
  scope: string;
  subjects?: string[];
  taskSummary: string;
  filesTouched?: FilesTouchedInput;
  aiClient?: string;
  /** Hook session id. The hosted edition attributes friction + applied-memory signals to it; LocalBackend ignores. */
  sessionId?: string;
  /** Friction counts to persist (hosted-only). */
  friction?: ActivityFriction;
  /**
   * Explicit positive signal — memory ids the agent actually applied this turn.
   * The hosted edition records them to its affinity model; LocalBackend ignores
   * (the affinity model is a hosted-only curation surface).
   */
  appliedMemoryIds?: string[];
  /**
   * Exploration-suppression signal (observational). Read-only discovery
   * calls (Grep/Glob/Read/...), file-writing calls, and the derived sufficiency
   * verdict for this turn. The hosted edition persists them on the activity row;
   * LocalBackend ignores (the measurement surface is hosted-only). Omit for a turn
   * with no tool stream (then the row stays `unknown` / NULL).
   */
  exploreCalls?: number;
  editCalls?: number;
  contextSufficiency?: "sufficient" | "explored" | "unknown";
  /**
   * Team signal derived from an explicit prompt preference.
   * Hosted-only, compact, and absent for ordinary activities. The raw prompt is
   * never carried here.
   */
  teamIntelligenceSignal?: ActivityTeamIntelligenceSignal;
}
/** The persisted activity row, returned by `logActivity` so callers can echo id/created_at. */
export interface ActivityRecord {
  provenance?: ActivityProvenance;
  id: string;
  workspaceId: string;
  nodePath: string;
  domain: string;
  action: string;
  scope: string;
  subjects: string[];
  taskSummary: string;
  filesTouched: FilesTouchedInput;
  aiClient: string;
  /** Display fields populated by the hosted edition; LocalBackend defaults them. */
  detailLevel?: string;
  status?: string;
  createdAt: string;
  toolCallCount?: number;
  toolFailureCount?: number;
  toolFailureCodes?: string[];
  /** Exploration-suppression signal (hosted-only; undefined on LocalBackend / legacy rows). */
  exploreCalls?: number;
  editCalls?: number;
  contextSufficiency?: "sufficient" | "explored" | "unknown";
  teamIntelligenceScore?: number;
  teamIntelligenceCategory?: ActivityTeamIntelligenceSignal["category"];
  teamIntelligenceSurface?: ActivityTeamIntelligenceSignal["surface"];
}
/**
 * Lean activity projection for `recentActivities` / context assembly. The optional fields are
 * what the console's Activity page shows; a backend fills the ones it keeps.
 */
export interface Activity {
  id: string;
  nodePath: string | null;
  domain: string | null;
  action: string | null;
  taskSummary: string | null;
  createdAt: string;
  scope?: string | null;
  subjects?: string[];
  /** `files_touched` as stored (`{ by_area, total }`, or a legacy shape); readers flatten it. */
  filesTouched?: unknown;
  aiClient?: string | null;
  /** The account the activity was logged for (hosted); LocalBackend has one principal and none. */
  actorId?: string | null;
}

/** What `recentActivities` may narrow to: entries created at or after `since` (ISO). */
export interface RecentActivitiesOptions {
  since?: string;
}

// ── Refresh queue ───────────────────────────────────────────────────────────
// The rich queue contract (RefreshRow / RefreshBrief / PendingRefreshSummary /
// RequestRefreshResult / RefreshStatus) lives in @pathrule/shared and the backend
// interface imports it from there (type-only). Core owns only the request *input*
// shape below — keyed by a concrete memory/rule subject.
export type RequestRefreshKind =
  | "drift"
  | "contradicts_code"
  | "duplicate"
  | "too_narrow"
  | "unclear";
export interface RequestRefreshInput {
  subjectType: "memory" | "rule";
  subjectId: string;
  reason: string;
  kind?: RequestRefreshKind;
}

// ── Tree / node detail ───────────────────────────────────────────────────────
/**
 * A node plus the ids of its directly-attached memories/rules/skills. Backs the
 * `get_node` tool (camelCase; the handler maps to its snake_case output contract).
 */
export interface NodeDetailRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  type: string;
  relativePath: string;
  memoryIds: string[];
  ruleIds: string[];
  skillIds: string[];
}

/** A minimal node reference resolved by workspace-relative path (backs get_context step 1). */
export interface NodeRef {
  id: string;
  name: string;
  relativePath: string;
}

/**
 * Raw content attached to a node — bodies included so the handler can build previews +
 * infer semantic_tags. (The handler owns the presentation shaping; the backend owns the read.)
 */
export interface NodeContent {
  memories: Array<{
    id: string;
    title: string;
    content: string;
    semanticTags?: readonly string[] | null;
  }>;
  rules: Array<{
    id: string;
    name: string;
    content: string;
    scopeType: string;
    priority: string;
    semanticTags?: readonly string[] | null;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
    source: string;
    tags?: string[] | null;
    semanticTags?: readonly string[] | null;
  }>;
}

/** A workspace skill with its EFFECTIVE content resolved — for ::skill-name invocation matching. */
export interface InvocationSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  githubUrl: string | null;
}

// ── Relevant memories for a path (node-owner ∪ context-link union) ──────
export interface RelevantMemoryRow {
  memory_id: string;
  node_id: string;
  title: string;
  via: "node_owner" | "context_link";
  /** The context-link path that caused inclusion; null for node-owner hits. */
  matched_path: string | null;
  confidence: number | null;
}

// ── Optional (bring-your-own-key / hosted) capabilities ──────────────────────
// The canonical router input lives in @pathrule/shared so the MCP server's intent
// router, the KnowledgeBackend.routeIntent seam, and the bring-your-own ai-route
// adapter all share one shape. Re-exported here for backend implementers.
export type {
  RouteIntentInput,
  // Semantic candidates seam. Canonical shapes live in @pathrule/shared
  // (next to RouteIntentInput) so the hosted client, the KnowledgeBackend
  // seam, and the bring-your-own embedding adapter share one contract.
  SemanticQuery,
  SemanticCandidatesResult,
  SemanticCandidatesPayload,
  SemanticCandidateOut,
} from "@pathrule/protocol/routing-types.js";
// Workspace resolution seam.
export type { WorkspaceMatch, ClosestNode } from "@pathrule/protocol/node-types.js";
