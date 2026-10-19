// SPDX-License-Identifier: Apache-2.0
// Adaptive routing types shared between MCP server and hooks.
// Includes task_shape + context_depth for unified get_context.
//
// The routing service returns a RoutingDecision; the MCP server wraps
// it in a RoutingResult that also carries fallback / preload info.

export type RoutingNext =
  | "read_memory"
  | "execute_only"
  | "edit_known_path"
  | "answer_directly"
  | "no_action"
  // Deprecated — router no longer auto-routes to the removed
  // `understand` tool. Kept in the union so old routers' output
  // still parses (we treat it as "no_action" on the server).
  | "call_understand";

/**
 * The kind of work the user is asking for. Drives `context_depth`.
 * Router classifies intent into one of these shapes.
 */
export type TaskShape =
  | "ui_tweak" // small visual/styling change, single component
  | "new_feature" // add functionality, usually to a known file
  | "bug_fix" // fix a specific symptom on a known file/path
  | "refactor" // restructure code in a known area
  | "debug" // cause unknown — discovery needed
  | "discovery" // "how does X work?" / exploration
  | "unknown"; // router can't classify → defaults to focused

/**
 * How much context the MCP server should return.
 * - minimal: primary_files + rules + path-scoped memory titles + top 3 recent activities (~250 tok)
 * - focused: + ancestor memory titles + top 5 recent activities + maybe prior_solutions (~600 tok)
 * - deep: + workspace_overview + hot_paths + coupled_nodes + full briefing (~1.5k tok)
 */
export type ContextDepth = "minimal" | "focused" | "deep";

/**
 * Optional payload sections the router can request the MCP server to include
 * on the wire. Empty array → omit all optional sections (base context only).
 * Absent / undefined → caller picks based on context_depth.
 *
 * `preload_memory:<uuid>` is a parameterised section that asks the server to
 * inline a specific memory body in the get_context response.
 */
export type ResponseSection =
  | "hot_paths"
  | "recent_activities"
  | "prior_solutions"
  | "prior_work"
  | "coupled_nodes"
  | "workspace_overview"
  | `preload_memory:${string}`;

export interface RoutingDecision {
  next: RoutingNext;
  reason: string;
  memory_id?: string;
  confidence: "high" | "low";
  /** Adaptive response shaping. See `ResponseSection` doc. */
  include?: ResponseSection[];
  /** Task classification. */
  task_shape?: TaskShape;
  /** Context depth. Drives which fields get_context returns. */
  context_depth?: ContextDepth;
  /**
   * Concrete workspace-relative file paths the router thinks the user
   * wants Claude to edit (only set when confidence=high AND task_shape is one
   * of ui_tweak/new_feature/bug_fix/refactor). Empty or absent = not known.
   */
  primary_files?: string[];
}

export type RoutingFallbackReason =
  | "no_user_intent"
  | "edge_timeout"
  | "edge_error"
  | "edge_parse_failure"
  | "edge_invalid_input"
  | "edge_auth_required"
  | "parse_failure"
  | "offline"
  // The resolved backend exposes no LLM router (no managed service / no BYO key).
  // get_context degrades to the deterministic router. Not an error.
  | "router_unavailable";

export interface RoutingResult {
  decision?: RoutingDecision;
  fallback?: RoutingFallbackReason;
  latency_ms?: number;
}

// ── Canonical router input (shared by mcp-server's routeUserIntent, the
// KnowledgeBackend.routeIntent seam, and the BYO routing adapter in core). ──────
export interface RouterWorkspaceOverviewEntry {
  relative_path: string;
  memory_titles?: Array<{ id: string; title: string }>;
  rule_names?: string[];
  skill_names?: string[];
}

export interface RouterRecentActivityEntry {
  domain: string;
  action: string;
  task_summary: string;
  created_at: string;
  node_path?: string;
  files_touched?: unknown;
}

export interface RouteIntentInput {
  workspaceId: string;
  userIntent: string;
  workspaceOverview: RouterWorkspaceOverviewEntry[];
  recentActivities: RouterRecentActivityEntry[];
}

export interface SubtreeMemoryIndexEntry {
  id: string;
  title: string;
  node_path: string;
}

export interface SubtreeMemoryIndexResult {
  entries: SubtreeMemoryIndexEntry[];
  truncated: boolean;
  total: number;
}

// ── Semantic candidates (BYO-key / hosted) ──────────────────────────────────
// The canonical shapes live here so mcp-server's runSemanticCandidates, the
// KnowledgeBackend.semanticCandidates seam, and the OSS BYO-embedding adapter
// all share one contract (mirrors RouteIntentInput's placement). The hosted
// client is injected into the hosted backend as a closure, so SemanticQuery
// carries only the backend-agnostic inputs.

export interface SemanticCandidateOut {
  id: string;
  title: string;
  node_path: string;
  similarity: number;
  source: "semantic";
  confidence: "high" | "medium";
  lexical_overlap?: boolean;
  reason?: string;
}

export interface SemanticCandidatesPayload {
  candidates: SemanticCandidateOut[];
  model: string;
  searched_scope: {
    matched_node_path: string;
    limit: number;
    min_similarity: number;
  };
}

/** What the get_context handler consumes from one semantic search run. */
export interface SemanticCandidatesResult {
  payload: SemanticCandidatesPayload | undefined;
  /** Reason the field was not emitted, for debug/telemetry only. */
  skipped?: "unconfigured" | "provider_failure" | "rpc_failure" | "no_candidates" | "empty_intent";
  latencyMs?: number;
}

/**
 * Backend-agnostic input for `KnowledgeBackend.semanticCandidates`. The lexical
 * surface (bundle memories + subtree index + discovery titles) is threaded in
 * so the candidate shaper can mark `lexical_overlap` / drop already-shown ids —
 * only memory ids are read from `bundleMemories` / `discoveryCandidateTitles`.
 */
export interface SemanticQuery {
  workspaceId: string;
  userIntent: string;
  matchedNodePath: string;
  bundleMemories: Array<{ id: string }> | undefined;
  subtreeIndex: SubtreeMemoryIndexResult | undefined;
  discoveryCandidateTitles: Array<{ id: string }> | undefined;
  limit?: number;
  minSimilarity?: number;
}

export interface DiscoverySignal {
  /** True when the matched node has zero directly attached memories. */
  no_direct_memories: boolean;
  /** Count of memories surfaced from descendant nodes within subtree_budget. */
  descendants_have_memories: number;
  /** Up to 5 descendant candidates for follow-up pathrule_read_memory(id). */
  candidate_memory_titles?: SubtreeMemoryIndexEntry[];
  searched_scope: {
    matched_node_path: string;
    /** 0 means subtree was not searched yet. */
    subtree_budget: number;
    subtree_truncated: boolean;
    ancestors_walked: boolean;
  };
  recommendation?:
    | "answer_from_subtree_titles"
    | "inspect_semantic_candidates"
    | "low_semantic_confidence"
    | "open_workspace_overview"
    | "widen_subtree_budget"
    | "no_match_in_workspace";
  semantic_candidates_count?: number;
  semantic_high_confidence_count?: number;
  semantic_instruction?: string;
}

export type DeterministicIntentClass =
  | "execute_only"
  | "known_file_edit"
  | "known_area_ui"
  | "known_area_bug"
  | "recent_activity_question"
  | "history_question"
  | "workspace_inventory"
  | "architecture_discovery"
  | "unknown";

export interface DeterministicRoute {
  intent_class: DeterministicIntentClass;
  task_shape?: TaskShape;
  context_depth: ContextDepth;
  next: RoutingNext;
  confidence: number;
  reason: string;
  primary_files?: string[];
  include?: ResponseSection[];
  skip_llm_router: boolean;
}
