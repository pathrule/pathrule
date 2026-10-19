// SPDX-License-Identifier: Apache-2.0
// Intelligence Layer — shared types for briefings and engine results.

export interface NodeBrief {
  node_id: string;
  path: string;
  name: string;
  memory_titles: string[];
  rule_names: string[];
  skill_names: string[];
  match_source: "fuzzy" | "body_preview" | "co_change";
  relevance: number; // 0–1
}

export interface PriorSolution {
  memory_id: string;
  title: string;
  preview: string; // first 200 chars
  related_paths: string[];
  created_at: string;
}

export interface WorkEpisodeBrief {
  id: string;
  title: string;
  summary: string;
  subjects: string[];
  paths: string[];
  activity_count: number;
  started_at: string;
  ended_at: string;
  confidence: "low" | "medium" | "high";
  evidence_activity_ids?: string[];
}

export interface RecentSession {
  paths_touched: string[];
  memories_written: string[];
  hint: string; // "Last session focused on watcher + sidebar"
}

export interface HotPath {
  path: string;
  change_count: number;
}

export interface RuleBrief {
  id: string;
  name: string;
  priority: string;
  scope_type: string;
}

export interface SkillBrief {
  id: string;
  name: string;
}

/**
 * Recent-activity projection that feeds the get_context router + deep briefing
 * (snake_case; carries `node_path` + `files_touched`). Distinct from the lean
 * camelCase `Activity` used by `recentActivities()` — this one is the router's
 * consumed shape, so the backend method `recentActivitiesForRouter` returns it.
 * The hosted backend applies a per-user filter; LocalBackend ignores the user
 * filter (single principal).
 */
export interface RecentActivityForRouter {
  domain: string;
  action: string;
  task_summary: string;
  created_at: string;
  node_path?: string;
  files_touched?: unknown;
}

/** Activity log entry surfaced in briefings. */
export interface ActivityEntry {
  domain: string;
  action: string;
  scope: string;
  subjects: string[];
  task_summary: string;
  node_path: string;
  files_touched: { total: number; by_area: Record<string, string[]> };
  created_at: string; // ISO date
}

export interface ResearchBriefing {
  summary: string;
  /**
   * Match arrays. These are OPTIONAL on the wire: empty arrays
   * are omitted from the JSON to save bytes. Callers MUST default to `[]` —
   * e.g. `(briefing.primary_nodes ?? []).length`. Absent and `[]` mean the
   * same thing.
   */
  primary_nodes?: NodeBrief[];
  coupled_nodes?: NodeBrief[];
  rules_in_scope?: RuleBrief[];
  skills_in_scope?: SkillBrief[];
  prior_solutions?: PriorSolution[];
  prior_work?: WorkEpisodeBrief[];
  recent_session: RecentSession | null;
  hot_paths?: HotPath[];
  /** Recent activity logs relevant to the problem. */
  recent_activities?: ActivityEntry[];
  /**
   * True when no match arrays produced any results. Single-flag
   * short-circuit so callers don't need to inspect five arrays to detect
   * the empty case.
   */
  no_matches?: true;
  confidence: number; // 0–1
  suggested_order?: string[]; // node paths in recommended read order
}

/** Entry in the Engine 1 in-memory fuzzy index. */
export interface ProjectMapEntry {
  node_id: string;
  path: string;
  name: string;
  memory_titles: string[];
  rule_names: string[];
  skill_names: string[];
  /** First 400 chars of each memory/rule/skill body, concatenated. */
  body_preview: string;
}

/**
 * Result of a fuzzy project-map search.
 * `nodes` are the ranked node briefs (relevance 0–1, descending); `topScore` is
 * the best raw pre-round score across all matches that cleared the cutoff.
 * Lives here so @pathrule/core can return it without importing from mcp-server.
 */
export interface ProjectMapSearchResult {
  nodes: NodeBrief[];
  topScore: number;
}

/**
 * Input to `assembleBriefing`. Lives here so @pathrule/core can compose a
 * briefing locally. The backend computes prior_solutions internally from
 * `primaryPaths` (or the primaryNodes' paths).
 */
export interface AssembleBriefingInput {
  workspaceId: string;
  /** Optional intent text — telemetry only, not used by the algorithm. */
  intent?: string;
  /** Paths used to compute prior_solutions; falls back to the primaryNodes' paths. */
  primaryPaths?: string[];
  primaryNodes: NodeBrief[];
  coupledNodes: NodeBrief[];
  hotPaths: HotPath[];
  recentSession: RecentSession | null;
  recentActivities?: ActivityEntry[];
  stackSignals?: Record<string, unknown>;
}
