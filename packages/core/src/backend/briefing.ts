// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic research-briefing composition. Composes primary/coupled nodes +
 * prior_solutions + recent_session + hot_paths + activities into a
 * ResearchBriefing: dedup, rule/skill collection, 5-tier suggested_order,
 * summary, no_matches, and a 3000-token budget trim. Shared by the
 * SQLite-backed and in-memory backends. No `better-sqlite3` import.
 * prior_solutions is computed by the caller (its own rankPriorSolutions) and
 * passed in.
 */
import type {
  AssembleBriefingInput,
  NodeBrief,
  PriorSolution,
  ResearchBriefing,
  RuleBrief,
  SkillBrief,
} from "@pathrule/protocol/intelligence-types.js";

const MAX_TOKEN_BUDGET = 3000;

/** 5-tier suggested_order ranking. */
function computeSuggestedOrder(
  primary: NodeBrief[],
  coupled: NodeBrief[],
  priorSolutions: PriorSolution[],
  recentActivities: AssembleBriefingInput["recentActivities"],
  confidence: number,
): string[] {
  const max = confidence > 0.9 ? 5 : 10;
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (path: string | null | undefined): void => {
    if (order.length >= max) return;
    if (!path || seen.has(path)) return;
    seen.add(path);
    order.push(path);
  };

  // Tier 1: prior_solutions.related_paths (array order)
  for (const ps of priorSolutions) for (const p of ps.related_paths ?? []) add(p);
  // Tier 2a: primary nodes with rules
  for (const n of primary) if ((n.rule_names ?? []).length > 0) add(n.path);
  // Tier 2b: coupled nodes with rules
  for (const n of coupled) if ((n.rule_names ?? []).length > 0) add(n.path);
  // Tier 2.5: recent activity paths
  for (const a of recentActivities ?? []) add(a.node_path);
  // Tier 3: all coupled nodes (already co-change ranked)
  for (const n of coupled) add(n.path);
  // Tier 4: primary fuzzy nodes by relevance DESC
  for (const n of [...primary]
    .filter((x) => x.match_source === "fuzzy")
    .sort((a, b) => b.relevance - a.relevance)) {
    add(n.path);
  }
  // Tier 5: primary body_preview nodes by relevance DESC
  for (const n of [...primary]
    .filter((x) => x.match_source === "body_preview")
    .sort((a, b) => b.relevance - a.relevance)) {
    add(n.path);
  }
  return order;
}

/** Unique names from primary+coupled nodes, preserving first-seen order. */
function collectUniqueNames(nodes: NodeBrief[], key: "rule_names" | "skill_names"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of nodes) {
    for (const name of n[key] ?? []) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

function estimateTokens(briefing: ResearchBriefing): number {
  return Math.ceil(JSON.stringify(briefing).length / 4);
}

/** Iterative 3000-token trim, applying the trimming strategies below in order. */
function trimToBudget(briefing: ResearchBriefing, maxTokens: number): ResearchBriefing {
  const b = briefing;
  if (estimateTokens(b) <= maxTokens) return b;

  if (b.recent_activities && b.recent_activities.length > 3) {
    b.recent_activities = b.recent_activities.slice(0, 3);
    if (estimateTokens(b) <= maxTokens) return b;
  }
  if (b.prior_solutions && b.prior_solutions.length > 3) {
    b.prior_solutions = b.prior_solutions.slice(0, 3);
    if (estimateTokens(b) <= maxTokens) return b;
  }
  const collapse = (nodes: NodeBrief[] | undefined): NodeBrief[] | undefined =>
    nodes?.map((n) =>
      (n.memory_titles ?? []).length > 3
        ? { ...n, memory_titles: [`${n.memory_titles.length} memories`] }
        : n,
    );
  if (b.primary_nodes) b.primary_nodes = collapse(b.primary_nodes);
  if (b.coupled_nodes) b.coupled_nodes = collapse(b.coupled_nodes);
  if (estimateTokens(b) <= maxTokens) return b;

  if (b.coupled_nodes && b.coupled_nodes.length > 5) {
    b.coupled_nodes = b.coupled_nodes.slice(0, 5);
    if (estimateTokens(b) <= maxTokens) return b;
  }
  if (b.primary_nodes && b.primary_nodes.length > 5) {
    b.primary_nodes = b.primary_nodes.slice(0, 5);
  }
  return b;
}

/**
 * Compose a ResearchBriefing from the engine outputs + the caller's prior_solutions.
 * Omits empty arrays and undefined fields from the emitted payload.
 */
export function assembleBriefingLocal(
  input: AssembleBriefingInput,
  priorSolutions: PriorSolution[],
): ResearchBriefing {
  const primary = input.primaryNodes ?? [];
  let coupled = input.coupledNodes ?? [];

  // Dedup recent_session.memories_written against prior_solutions titles.
  let recentSession = input.recentSession;
  if (recentSession && priorSolutions.length > 0) {
    const solutionTitles = new Set(priorSolutions.map((p) => p.title));
    recentSession = {
      ...recentSession,
      memories_written: (recentSession.memories_written ?? []).filter(
        (t) => !solutionTitles.has(t),
      ),
    };
  }

  // Dedup coupled against primary by node_id.
  if (coupled.length > 0 && primary.length > 0) {
    const primaryIds = new Set(primary.map((n) => n.node_id));
    coupled = coupled.filter((n) => !primaryIds.has(n.node_id));
  }

  const ruleNames = collectUniqueNames([...primary, ...coupled], "rule_names");
  const skillNames = collectUniqueNames([...primary, ...coupled], "skill_names");
  const rules: RuleBrief[] = ruleNames.map((name) => ({
    id: "",
    name,
    priority: "",
    scope_type: "",
  }));
  const skills: SkillBrief[] = skillNames.map((name) => ({ id: "", name }));

  const confidence = primary.length > 0 ? Math.max(...primary.map((n) => n.relevance)) : 0;
  const suggestedOrder = computeSuggestedOrder(
    primary,
    coupled,
    priorSolutions,
    input.recentActivities,
    confidence,
  );

  const totalNodes = primary.length + coupled.length;
  const uniquePaths = new Set(
    [...primary, ...coupled].map((n) => n.path).filter((p): p is string => Boolean(p)),
  ).size;
  const summary = `Found ${totalNodes} relevant node${totalNodes === 1 ? "" : "s"} across ${uniquePaths} path${uniquePaths === 1 ? "" : "s"}`;

  const noMatches =
    primary.length === 0 &&
    coupled.length === 0 &&
    priorSolutions.length === 0 &&
    rules.length === 0 &&
    skills.length === 0;

  const briefing: ResearchBriefing = {
    summary,
    confidence: Math.round(confidence * 100) / 100,
    recent_session: recentSession,
  };
  if (primary.length > 0) briefing.primary_nodes = primary;
  if (coupled.length > 0) briefing.coupled_nodes = coupled;
  if (rules.length > 0) briefing.rules_in_scope = rules;
  if (skills.length > 0) briefing.skills_in_scope = skills;
  if (priorSolutions.length > 0) briefing.prior_solutions = priorSolutions;
  if ((input.hotPaths ?? []).length > 0) briefing.hot_paths = input.hotPaths;
  if ((input.recentActivities ?? []).length > 0)
    briefing.recent_activities = input.recentActivities;
  if (noMatches) briefing.no_matches = true;
  if (suggestedOrder.length > 0) briefing.suggested_order = suggestedOrder;

  return trimToBudget(briefing, MAX_TOKEN_BUDGET);
}
