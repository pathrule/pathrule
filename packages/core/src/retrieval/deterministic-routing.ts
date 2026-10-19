// SPDX-License-Identifier: Apache-2.0
//
// Pure, network-free intent router: the MCP server classifies a user turn
// without a network roundtrip. It is regex/string logic only — no network, no
// SQLite, no node-only deps — so it runs the same wherever it is imported.

import type {
  ContextDepth,
  DeterministicRoute,
  ResponseSection,
  RoutingDecision,
  TaskShape,
} from "@pathrule/protocol/routing-types.js";
import type { WorkspaceOverviewNode } from "../tools/overview.js";

export interface RecentActivityForRouting {
  task_summary: string;
  node_path?: string;
  files_touched?: unknown;
}

export interface DeterministicRouteInput {
  userIntent: string;
  relativePath: string;
  recentActivities: RecentActivityForRouting[];
  workspaceOverview?: WorkspaceOverviewNode[];
}

const EXECUTE_ONLY_PATTERNS = [
  /\bgit\s+(status|diff|log|show|add|commit|push|pull|fetch|stash)\b/i,
  /\bgit\b.*\b(status|diff|log|show|add|commit\w*|push|pull|fetch|stash)\b/i,
  /\b(pnpm|npm|yarn|bun)\s+[\w:-]+/i,
  /^\s*(typecheck|lint|test|build|format)\s*$/i,
  /\b(run|calistir|çalıştır|kontrol et|check)\b.*\b(status|typecheck|lint|test|build)\b/i,
];

const RECENT_ACTIVITY_PATTERNS = [
  /\b(last|recent|previous)\s+(session|work|change|activity)\b/i,
  /\b(yesterday|today)\b/i,
  /\b(son|onceki|önceki|gecen|geçen)\s+(oturum|session|calisma|çalışma|degisiklik|değişiklik)\b/i,
  /\b(ne yaptik|ne yaptık|neler yaptik|neler yaptık)\b/i,
];

const HISTORY_PATTERNS = [
  /\+\+history\b/i,
  /\b(previously|prior work|past work|history|how did we implement|how was .* implemented|update again)\b/i,
  /\b(daha once|daha önce|eskiden|gecmiste|geçmişte|once nasil|önce nasıl|nasil yapmistik|nasıl yapmıştık|nerede yapmistik|nerede yapmıştık)\b/i,
];

const INVENTORY_PATTERNS = [
  /\b(list|show|hangi|neler|tum|tüm)\b.*\b(memories|memory|rules|skills|rule|skill)\b/i,
  /\b(workspace|repo)\b.*\b(map|overview|inventory|envanter)\b/i,
  /\bpathrule\b.*\b(memory|rule|skill|overview|inventory|envanter)\b/i,
];

const ARCHITECTURE_PATTERNS = [
  /\b(architecture|mimari|how does|nasil calis|nasıl çalış)\b/i,
  /\b(nasil|nasıl)\s+(calis\w*|çalış\w*)\b/i,
  /\b(detayli|detaylı|deep|derin)\b.*\b(analiz|analyze|incele)\b/i,
  /\b(neden|why)\b.*\b(token|context|routing|gürültü|gurultu|noise)\b/i,
];

const CONTEXT_QUALITY_PATTERNS = [
  /\b(hook|mcp|get_context|context|bağlam|baglam|router|routing)\b.*\b(noise|gürültü|gurultu|yeterli|sufficient|doğru|dogru|verimli|efficient|fallback|yetmedi|çözemedim|cozemedim|token)\b/i,
  /\b(noise|gürültü|gurultu|yeterli|sufficient|doğru|dogru|verimli|efficient|fallback|yetmedi|çözemedim|cozemedim|token)\b.*\b(hook|mcp|get_context|context|bağlam|baglam|router|routing)\b/i,
];

const RELEASE_TEST_STRATEGY_PATTERNS = [
  /\b(release|ship|gate|quality|qa|regression)\b.*\b(test|suite|coverage|rubric|score|scoring)\b/i,
  /\b(test|suite|coverage|rubric|score|scoring)\b.*\b(release|ship|gate|quality|qa|regression)\b/i,
  /\b(hook|mcp|context|router|routing|token|skill|skorlama|scoring)\b.*\b(test|coverage|gate)\b/i,
  /\b(tum|tüm|butun|bütün)\b.*(ozellik|özellik|feature).*\b(test|dene|doğrula|dogrula)\b/i,
  /\b(kapsamli|kapsamlı|comprehensive)\b.*\b(test|qa|dogrula|doğrula)\b/i,
];

const DEBUG_PERFORMANCE_PATTERNS = [
  /\b(router|routing|mcp|context|get_context)\b.*\b(timeout|telemetry|latency|restart|performans|performance|kök sebep|kok sebep|analiz|analyze)\b/i,
  /\b(timeout|telemetry|latency|restart|performans|performance|kök sebep|kok sebep)\b.*\b(router|routing|mcp|context|get_context)\b/i,
];

const UI_PRODUCT_PATTERNS = [
  /\b(ui|ux|frontend|front-end|component|modal|dialog|drawer|popover|tooltip|button|card|form|table|sidebar|navbar|layout|view|screen|page)\b/i,
  /\b(i18n|translation|locale|responsive|accessibility|a11y|design|style|theme)\b/i,
  /\b(tree|collapse|collapsed|expand|toggle|onboarding|mobile|tab|badge|empty state|loading state)\b/i,
  /\b(ekran|sayfa|bileşen|bilesen|tasarım|tasarim|çeviri|ceviri|yerleşim|yerlesim|görünüm|gorunum|buton|kart|sekme|rozet)\b/i,
];

const UI_FOCUSED_PATTERNS = [
  /\b(refactor|standard|standart|pattern|decision|karar ver|mantıklı mı|mantikli mi|yeniden|toparla|düzenle|duzenle|ele al)\b/i,
  /\b(standardına|standardina|standardı|standardi|toggle|collapse|onboarding)\b/i,
];

const BUG_PATTERNS = [
  /\b(bug|fix|refactor|hata|yanlis|yanlış|bozuk|broken|fail|failing|takil|takıl|sebebini bul|nedenini bul)\b/i,
  /\b(düzelt|duzelt|iyileştir|iyilestir|elden gecir|elden geçir|kontrol et)\b/i,
  /\b(takil\w*|takıl\w*)\b/i,
];

const FILE_PATTERN = /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|css|scss|html|yml|yaml)\b/g;

// Stopwords for memory-title keyword match. We deliberately drop bug-words and
// auxiliary verbs so they don't count toward the 2-token threshold below.
const KEYWORD_STOPWORDS = new Set([
  // Turkish particles + auxiliaries
  "var",
  "yok",
  "ile",
  "icin",
  "için",
  "gibi",
  "bir",
  "bu",
  "şu",
  "için",
  "geliyor",
  "oluyor",
  "olsun",
  "gerek",
  "gerekiyor",
  "lazim",
  "lazım",
  "yapıyor",
  "yapiyor",
  "biraz",
  "neden",
  "niye",
  "sebebini",
  "nedenini",
  "kontrol",
  "olarak",
  "ancak",
  "ama",
  "fakat",
  "yani",
  "değil",
  "degil",
  // Bug-words (already gating elsewhere; do not let them score)
  "bug",
  "fix",
  "hata",
  "yanlis",
  "yanlış",
  "bozuk",
  "broken",
  "fail",
  "failing",
  "takil",
  "takıl",
  "takiliyor",
  "takılıyor",
  "wrong",
  "bul",
  "olabilir",
  "sebep",
  // English particles
  "the",
  "and",
  "but",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "this",
  "that",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "any",
  "all",
  "should",
  "would",
  "could",
  "may",
  "might",
  "can",
  "will",
  "show",
  "see",
  "look",
  "make",
  "take",
  "use",
  "than",
  "then",
]);

const MEMORY_MATCH_MIN_TOKENS = 2;
const MEMORY_MATCH_MIN_TOKEN_LENGTH = 3;

function normalizeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath === ".") return "/";
  return relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
}

function hasAny(intent: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(intent));
}

function extractMentionedFiles(intent: string): string[] {
  return Array.from(new Set(intent.match(FILE_PATTERN) ?? []));
}

function stringifyFilesTouched(filesTouched: unknown): string {
  if (!filesTouched) return "";
  try {
    return JSON.stringify(filesTouched);
  } catch {
    return "";
  }
}

function findRecentFileMatches(
  mentionedFiles: string[],
  recentActivities: RecentActivityForRouting[],
): string[] {
  if (mentionedFiles.length === 0) return [];
  const matches = new Set<string>();
  for (const activity of recentActivities) {
    const haystack = `${activity.task_summary} ${stringifyFilesTouched(activity.files_touched)}`;
    for (const file of mentionedFiles) {
      if (!haystack.includes(file)) continue;
      const quotedPath = haystack.match(
        new RegExp(`(?:[\\w./-]+/)?${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"),
      );
      if (quotedPath) {
        for (const p of quotedPath) {
          matches.add(p.replace(/^"+|"+$/g, ""));
        }
      } else if (activity.node_path && activity.node_path !== "/") {
        matches.add(`${activity.node_path.replace(/^\//, "")}/${file}`);
      } else {
        matches.add(file);
      }
    }
  }
  return Array.from(matches).slice(0, 3);
}

function extractKeywordTokens(intent: string): string[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9çğıöşü]+/)
    .filter((t) => t.length >= MEMORY_MATCH_MIN_TOKEN_LENGTH && !KEYWORD_STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

function ancestorPathsIncludingSelf(matchedRelativePath: string): Set<string> {
  const out = new Set<string>(["/"]);
  const normalized = normalizeRelativePath(matchedRelativePath);
  if (normalized === "/") return out;
  const parts = normalized.split("/").filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    out.add("/" + parts.slice(0, i).join("/"));
  }
  return out;
}

/**
 * Find a memory whose title shares ≥ MEMORY_MATCH_MIN_TOKENS keyword tokens
 * with the user intent. Scope is restricted to the matched node + ancestors
 * + root so we never surface a memory from an unrelated subtree. Wrong-file
 * suggestions hurt Pathrule's "I know your codebase" promise more than
 * silence does — the threshold is intentionally conservative.
 */
function findMemoryMatchByTitle(
  intent: string,
  workspaceOverview: WorkspaceOverviewNode[] | undefined,
  matchedRelativePath: string,
): { id: string; nodePath: string } | undefined {
  if (!workspaceOverview || workspaceOverview.length === 0) return undefined;
  const tokens = extractKeywordTokens(intent);
  if (tokens.length < MEMORY_MATCH_MIN_TOKENS) return undefined;
  const scope = ancestorPathsIncludingSelf(matchedRelativePath);

  let best: { id: string; nodePath: string; score: number; depth: number } | undefined;
  for (const node of workspaceOverview) {
    if (!scope.has(node.relative_path)) continue;
    const nodeDepth = node.relative_path === "/" ? 0 : node.relative_path.split("/").length;
    for (const memory of node.memories) {
      const titleLower = memory.title.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (titleLower.includes(tok)) score++;
      }
      if (score < MEMORY_MATCH_MIN_TOKENS) continue;
      // Tie-break by score, then prefer most-specific (deepest) node.
      if (!best || score > best.score || (score === best.score && nodeDepth > best.depth)) {
        best = { id: memory.id, nodePath: node.relative_path, score, depth: nodeDepth };
      }
    }
  }
  return best ? { id: best.id, nodePath: best.nodePath } : undefined;
}

function inferPrimaryFiles(input: DeterministicRouteInput): string[] | undefined {
  const mentionedFiles = extractMentionedFiles(input.userIntent);
  if (mentionedFiles.length === 0) return undefined;

  const recentMatches = findRecentFileMatches(mentionedFiles, input.recentActivities);
  if (recentMatches.length > 0) return recentMatches;

  const base = normalizeRelativePath(input.relativePath);
  if (base === "/") return mentionedFiles.slice(0, 3);
  return mentionedFiles.map((file) => `${base.replace(/^\//, "")}/${file}`).slice(0, 3);
}

function route(
  intent_class: DeterministicRoute["intent_class"],
  params: {
    context_depth: ContextDepth;
    next: DeterministicRoute["next"];
    confidence: number;
    reason: string;
    task_shape?: TaskShape;
    primary_files?: string[];
    include?: ResponseSection[];
    skip_llm_router?: boolean;
  },
): DeterministicRoute {
  return {
    intent_class,
    context_depth: params.context_depth,
    next: params.next,
    confidence: params.confidence,
    reason: params.reason,
    task_shape: params.task_shape,
    primary_files: params.primary_files,
    include: params.include,
    skip_llm_router: params.skip_llm_router ?? false,
  };
}

export function classifyDeterministicRoute(input: DeterministicRouteInput): DeterministicRoute {
  const intent = input.userIntent.trim();
  const primaryFiles = inferPrimaryFiles(input);

  if (!intent) {
    return route("unknown", {
      context_depth: "deep",
      next: "no_action",
      confidence: 0,
      reason: "No user intent was provided.",
      task_shape: "unknown",
      skip_llm_router: true,
    });
  }

  const broadReleaseTestIntent = hasAny(intent, RELEASE_TEST_STRATEGY_PATTERNS);

  if (!broadReleaseTestIntent && hasAny(intent, EXECUTE_ONLY_PATTERNS)) {
    return route("execute_only", {
      context_depth: "minimal",
      next: "execute_only",
      confidence: 0.95,
      reason: "Direct command; no workspace inventory.",
      task_shape: "unknown",
      include: [],
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, RECENT_ACTIVITY_PATTERNS)) {
    return route("recent_activity_question", {
      context_depth: "minimal",
      next: "answer_directly",
      confidence: 0.9,
      reason: "Question asks about recent Pathrule activity.",
      task_shape: "discovery",
      include: ["recent_activities"],
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, HISTORY_PATTERNS)) {
    return route("history_question", {
      context_depth: "focused",
      next: "answer_directly",
      confidence: 0.86,
      reason: "Question asks for relevant prior implementation work.",
      task_shape: "discovery",
      include: ["prior_work"],
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, INVENTORY_PATTERNS)) {
    return route("workspace_inventory", {
      context_depth: "focused",
      next: "answer_directly",
      confidence: 0.85,
      reason: "User explicitly asks for workspace memory/rule/skill inventory.",
      task_shape: "discovery",
      include: ["workspace_overview"],
      skip_llm_router: true,
    });
  }

  if (primaryFiles && primaryFiles.length > 0) {
    const memoryMatch = findMemoryMatchByTitle(intent, input.workspaceOverview, input.relativePath);
    return route("known_file_edit", {
      context_depth: hasAny(intent, BUG_PATTERNS) ? "focused" : "minimal",
      next: "edit_known_path",
      confidence: 0.8,
      reason: "Intent names concrete file(s), so context can be scoped to those paths.",
      task_shape: hasAny(intent, BUG_PATTERNS) ? "bug_fix" : "new_feature",
      primary_files: primaryFiles,
      include: memoryMatch ? [`preload_memory:${memoryMatch.id}` as ResponseSection] : undefined,
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, ARCHITECTURE_PATTERNS) || hasAny(intent, CONTEXT_QUALITY_PATTERNS)) {
    return route("architecture_discovery", {
      context_depth: "deep",
      next: "answer_directly",
      confidence: 0.85,
      reason: "Open-ended architecture, context quality, or noise analysis needs deep context.",
      task_shape: "discovery",
      include: ["workspace_overview", "recent_activities"],
      skip_llm_router: true,
    });
  }

  if (broadReleaseTestIntent) {
    return route("architecture_discovery", {
      context_depth: "deep",
      next: "answer_directly",
      confidence: 0.88,
      reason: "Broad release/QA test strategy needs deep Pathrule context, not a direct test command.",
      task_shape: "discovery",
      include: ["workspace_overview", "recent_activities"],
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, DEBUG_PERFORMANCE_PATTERNS)) {
    const memoryMatch = findMemoryMatchByTitle(intent, input.workspaceOverview, input.relativePath);
    return route("known_area_bug", {
      context_depth: "focused",
      next: "no_action",
      confidence: memoryMatch ? 0.82 : 0.76,
      reason: memoryMatch
        ? "Debug/performance intent matches a memory title in the current scope."
        : "Debug/performance intent can use the current Pathrule area without LLM routing.",
      task_shape: "debug",
      include: memoryMatch ? [`preload_memory:${memoryMatch.id}` as ResponseSection] : undefined,
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, UI_PRODUCT_PATTERNS)) {
    const memoryMatch = findMemoryMatchByTitle(intent, input.workspaceOverview, input.relativePath);
    const focused = hasAny(intent, UI_FOCUSED_PATTERNS) || memoryMatch !== undefined;
    return route("known_area_ui", {
      context_depth: focused ? "focused" : "minimal",
      next: "no_action",
      confidence: memoryMatch ? 0.86 : 0.78,
      reason: memoryMatch
        ? "UI/product intent matches a memory title in the current scope."
        : "UI/product intent can use local rules and path context without LLM routing.",
      task_shape: focused ? "new_feature" : "ui_tweak",
      include: memoryMatch ? [`preload_memory:${memoryMatch.id}` as ResponseSection] : undefined,
      skip_llm_router: true,
    });
  }

  if (hasAny(intent, BUG_PATTERNS)) {
    const memoryMatch = findMemoryMatchByTitle(intent, input.workspaceOverview, input.relativePath);
    return route("known_area_bug", {
      context_depth: "focused",
      next: "no_action",
      confidence: memoryMatch ? 0.78 : 0.7,
      reason: memoryMatch
        ? "Bug intent matches a memory title in the current scope."
        : "Bug-like intent without a file name; use the current node as scope.",
      task_shape: "bug_fix",
      include: memoryMatch ? [`preload_memory:${memoryMatch.id}` as ResponseSection] : undefined,
      skip_llm_router: true,
    });
  }

  return route("unknown", {
    context_depth: "focused",
    next: "no_action",
    confidence: 0.4,
    reason: "No deterministic high-confidence route matched.",
    task_shape: "unknown",
    skip_llm_router: false,
  });
}

export function deterministicDecision(routeResult: DeterministicRoute): RoutingDecision {
  return {
    next: routeResult.next,
    reason: routeResult.reason,
    confidence: routeResult.confidence >= 0.75 ? "high" : "low",
    task_shape: routeResult.task_shape,
    context_depth: routeResult.context_depth,
    primary_files: routeResult.primary_files,
    include: routeResult.include,
  };
}
