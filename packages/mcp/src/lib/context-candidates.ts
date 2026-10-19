// SPDX-License-Identifier: Apache-2.0
import { inferSemanticTags, semanticTagScore } from "@pathrule/core/retrieval/semantic-tags.js";
import type { ContextBundle } from "@pathrule/core/tools/tree.js";
import type { WorkspaceOverviewNode } from "@pathrule/core/tools/overview.js";

export type CandidateKind = "node" | "memory" | "rule" | "skill" | "recent_activity";
export type CandidateTaskHint =
  | "ui"
  | "backend"
  | "database"
  | "billing"
  | "debug"
  | "execute"
  | "generic";
export type RequestBroadness = "narrow" | "area" | "workspace";

export interface ContextCandidate {
  kind: CandidateKind;
  id: string;
  label: string;
  node_path: string;
  score: number;
  reasons: string[];
}

export interface ContextCandidateSet {
  broadness: RequestBroadness;
  task_hints: CandidateTaskHint[];
  tokens: string[];
  candidates: ContextCandidate[];
}

export interface ContextCandidateSummary {
  broadness: RequestBroadness;
  task_hints: CandidateTaskHint[];
  token_count: number;
  counts: Record<CandidateKind, number>;
  top: ContextCandidate[];
}

interface RecentActivityForCandidates {
  domain: string;
  action: string;
  task_summary: string;
  created_at: string;
  node_path?: string;
  files_touched?: unknown;
}

interface BuildContextCandidateSetInput {
  userIntent: string;
  relativePath: string;
  bundle: ContextBundle;
  recentActivities: RecentActivityForCandidates[];
}

const STOPWORDS = new Set([
  "the",
  "and",
  "but",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "what",
  "when",
  "where",
  "which",
  "should",
  "would",
  "could",
  "make",
  "take",
  "look",
  "show",
  "list",
  "bir",
  "bu",
  "şu",
  "ile",
  "icin",
  "için",
  "gibi",
  "bunu",
  "şunu",
  "onu",
  "çok",
  "cok",
  "daha",
  "biraz",
  "olarak",
  "kontrol",
  "et",
  "yap",
  "var",
  "yok",
]);

const BROAD_WORKSPACE_PATTERNS = [
  /\b(workspace|repo|project|proje)\b.*\b(refactor|restructure|cleanup|organize|düzenle|duzenle)\b/i,
  /\b(everywhere|global|tüm|tum|her yerde|genel)\b/i,
];

const BROAD_AREA_PATTERNS = [
  /\b(refactor|restructure|cleanup|standard|standart|dağıldı|dagildi|toparla|organize)\b/i,
  /\b(architecture|mimari|inventory|envanter|analyze|analiz|incele)\b/i,
  /\b(context|bağlam|baglam|hook|mcp|get_context|router|routing)\b.*\b(noise|gürültü|gurultu|yeterli|sufficient|verimli|efficient|token)\b/i,
];

const TASK_HINTS: Array<{ hint: CandidateTaskHint; patterns: RegExp[] }> = [
  { hint: "execute", patterns: [/\b(pnpm|npm|yarn|bun|git|typecheck|lint|test|build)\b/i] },
  {
    hint: "ui",
    patterns: [
      /\b(ui|ux|modal|component|tsx|css|design|tasarım|tasarim|i18n)\b/i,
      /\b(screen|page|view|layout|tree|collapse|toggle|onboarding|mobile|frontend|front-end|tab|badge)\b/i,
      /\b(ekran|sayfa|görünüm|gorunum|tasarım|tasarim|yerleşim|yerlesim|sekme|rozet)\b/i,
    ],
  },
  {
    hint: "database",
    patterns: [/\b(supabase|database|db|sql|migration|rpc|rls|edge function|edge-function)\b/i],
  },
  { hint: "billing", patterns: [/\b(stripe|billing|checkout|invoice|subscription|payment)\b/i] },
  {
    hint: "debug",
    patterns: [
      /\b(debug|bug|hata|timeout|latency|telemetry|performans|performance|mcp|router)\b/i,
      /\b(hook|context|bağlam|baglam|get_context|noise|gürültü|gurultu|token)\b/i,
    ],
  },
  { hint: "backend", patterns: [/\b(api|server|backend|electron|ipc|service|worker|queue)\b/i] },
];

function normalizePath(path: string | undefined): string {
  if (!path || path === ".") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9çğıöşü_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 30);
}

function inferBroadness(intent: string): RequestBroadness {
  if (BROAD_WORKSPACE_PATTERNS.some((pattern) => pattern.test(intent))) return "workspace";
  if (BROAD_AREA_PATTERNS.some((pattern) => pattern.test(intent))) return "area";
  return "narrow";
}

function inferTaskHints(intent: string): CandidateTaskHint[] {
  const hints = TASK_HINTS.filter((entry) =>
    entry.patterns.some((pattern) => pattern.test(intent)),
  ).map((entry) => entry.hint);
  return hints.length > 0 ? hints : ["generic"];
}

function pathAncestry(path: string): string[] {
  const normalized = normalizePath(path);
  if (normalized === "/") return ["/"];
  const parts = normalized.split("/").filter(Boolean);
  const out = ["/"];
  for (let i = 1; i <= parts.length; i++) {
    out.push("/" + parts.slice(0, i).join("/"));
  }
  return out;
}

function pathScore(
  candidatePath: string,
  currentPath: string,
): { score: number; reasons: string[] } {
  const candidate = normalizePath(candidatePath);
  const current = normalizePath(currentPath);
  if (candidate === "/") return { score: current === "/" ? 8 : 6, reasons: ["root-background"] };
  if (candidate === current) return { score: 25, reasons: ["current-path"] };
  if (pathAncestry(current).includes(candidate)) return { score: 18, reasons: ["ancestor-path"] };
  if (current !== "/" && candidate.startsWith(current + "/")) {
    return { score: 14, reasons: ["descendant-path"] };
  }
  return { score: 0, reasons: [] };
}

function overlapScore(label: string, tokens: string[]): { score: number; reasons: string[] } {
  const haystack = label.toLowerCase();
  const labelTokens = new Set(tokenize(label));
  const matches = tokens.filter(
    (token) => labelTokens.has(token) || (token.length >= 5 && haystack.includes(token)),
  );
  if (matches.length === 0) return { score: 0, reasons: [] };
  return {
    score: Math.min(30, matches.length * 8),
    reasons: [`token-overlap:${matches.slice(0, 3).join(",")}`],
  };
}

function hintScore(text: string, hints: CandidateTaskHint[]): { score: number; reasons: string[] } {
  const haystack = text.toLowerCase();
  const matched = TASK_HINTS.filter(
    (entry) =>
      hints.includes(entry.hint) && entry.patterns.some((pattern) => pattern.test(haystack)),
  ).map((entry) => entry.hint);
  if (matched.length === 0) return { score: 0, reasons: [] };
  return {
    score: Math.min(18, matched.length * 9),
    reasons: [`task-hint:${matched.join(",")}`],
  };
}

function semanticScore(
  contextTags: string[],
  targetTags: string[] | undefined,
): { score: number; reasons: string[] } {
  const tagPart = semanticTagScore(contextTags, targetTags);
  if (tagPart.score === 0) return { score: 0, reasons: [] };
  return {
    score: tagPart.score,
    reasons: [`semantic-tag:${tagPart.matches.slice(0, 3).join(",")}`],
  };
}

function filesTouchedText(filesTouched: unknown): string {
  if (!filesTouched) return "";
  try {
    return JSON.stringify(filesTouched);
  } catch {
    return "";
  }
}

function candidate(
  kind: CandidateKind,
  id: string,
  label: string,
  nodePath: string,
  scoreParts: Array<{ score: number; reasons: string[] }>,
): ContextCandidate {
  const score = scoreParts.reduce((sum, part) => sum + part.score, 0);
  const reasons = Array.from(new Set(scoreParts.flatMap((part) => part.reasons)));
  return {
    kind,
    id,
    label,
    node_path: normalizePath(nodePath),
    score,
    reasons,
  };
}

function currentNodeOverview(bundle: ContextBundle): WorkspaceOverviewNode | undefined {
  const path = normalizePath(bundle.node?.relative_path ?? bundle.resolved_workspace_path);
  if (bundle.memories.length === 0 && bundle.rules.length === 0 && bundle.skills.length === 0) {
    return undefined;
  }
  return {
    node_id: bundle.node?.id ?? "current",
    relative_path: path,
    memories: bundle.memories.map((memory) => ({
      id: memory.id,
      title: memory.title,
      semantic_tags: memory.semantic_tags,
    })),
    rules: bundle.rules,
    skills: bundle.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      source: skill.source,
      semantic_tags: skill.semantic_tags,
    })),
  };
}

function sortCandidates(items: ContextCandidate[]): ContextCandidate[] {
  return items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.node_path.length !== b.node_path.length) return b.node_path.length - a.node_path.length;
    return a.label.localeCompare(b.label);
  });
}

export function buildContextCandidateSet(
  input: BuildContextCandidateSetInput,
): ContextCandidateSet {
  const tokens = tokenize(input.userIntent);
  const contextTags = inferSemanticTags({ text: input.userIntent, limit: 8 });
  const broadness = inferBroadness(input.userIntent);
  const taskHints = inferTaskHints(input.userIntent);
  const currentPath = normalizePath(input.relativePath || input.bundle.resolved_workspace_path);
  const allNodes = [
    currentNodeOverview(input.bundle),
    ...(input.bundle.workspace_overview ?? []),
  ].filter((node): node is WorkspaceOverviewNode => Boolean(node));

  const candidates: ContextCandidate[] = [];
  for (const node of allNodes) {
    const nodeLabel = node.relative_path;
    const nodeTags = inferSemanticTags({ text: nodeLabel, path: node.relative_path });
    const nodePathPart = pathScore(node.relative_path, currentPath);
    const nodeOverlapPart = overlapScore(nodeLabel, tokens);
    const nodeHintPart = hintScore(nodeLabel, taskHints);
    const broadAreaPart =
      broadness !== "narrow" && (nodeOverlapPart.score > 0 || nodeHintPart.score > 0)
        ? { score: 10, reasons: ["broad-area-match"] }
        : { score: 0, reasons: [] };

    const nodeCandidate = candidate("node", node.node_id, nodeLabel, node.relative_path, [
      nodePathPart,
      nodeOverlapPart,
      nodeHintPart,
      semanticScore(contextTags, nodeTags),
      broadAreaPart,
    ]);
    if (nodeCandidate.score > 0) candidates.push(nodeCandidate);

    for (const memory of node.memories) {
      const label = memory.title;
      const overlap = overlapScore(label, tokens);
      const hint = hintScore(`${label} ${node.relative_path}`, taskHints);
      const memoryTags =
        memory.semantic_tags ?? inferSemanticTags({ text: label, path: node.relative_path });
      candidates.push(
        candidate("memory", memory.id, label, node.relative_path, [
          nodePathPart,
          overlap,
          hint,
          overlap.score > 0 || hint.score > 0 || broadness !== "narrow"
            ? semanticScore(contextTags, memoryTags)
            : { score: 0, reasons: [] },
          broadness !== "narrow" && (overlap.score > 0 || hint.score > 0)
            ? { score: 6, reasons: ["broad-supporting-memory"] }
            : { score: 0, reasons: [] },
        ]),
      );
    }

    for (const rule of node.rules) {
      const label = rule.name;
      const overlap = overlapScore(label, tokens);
      const hint = hintScore(`${label} ${node.relative_path}`, taskHints);
      const ruleTags =
        rule.semantic_tags ?? inferSemanticTags({ text: label, path: node.relative_path });
      const priorityBonus =
        rule.priority?.toLowerCase() === "high" && (overlap.score > 0 || hint.score > 0)
          ? { score: 7, reasons: ["relevant-high-priority"] }
          : { score: 0, reasons: [] };
      candidates.push(
        candidate("rule", rule.id, label, node.relative_path, [
          nodePathPart,
          overlap,
          hint,
          overlap.score > 0 || hint.score > 0 || broadness !== "narrow"
            ? semanticScore(contextTags, ruleTags)
            : { score: 0, reasons: [] },
          priorityBonus,
        ]),
      );
    }

    for (const skill of node.skills) {
      const label = skill.name;
      const skillTags =
        skill.semantic_tags ?? inferSemanticTags({ text: label, path: node.relative_path });
      candidates.push(
        candidate("skill", skill.id, label, node.relative_path, [
          nodePathPart,
          overlapScore(label, tokens),
          hintScore(`${label} ${node.relative_path}`, taskHints),
          semanticScore(contextTags, skillTags),
        ]),
      );
    }
  }

  for (const [index, activity] of input.recentActivities.entries()) {
    const label = activity.task_summary;
    const text = `${activity.domain} ${activity.action} ${label} ${activity.node_path ?? ""} ${filesTouchedText(
      activity.files_touched,
    )}`;
    const activityTags = inferSemanticTags({ text, path: activity.node_path });
    candidates.push(
      candidate(
        "recent_activity",
        `${activity.created_at}:${index}`,
        label,
        activity.node_path ?? "/",
        [
          pathScore(activity.node_path ?? "/", currentPath),
          overlapScore(text, tokens),
          hintScore(text, taskHints),
          semanticScore(contextTags, activityTags),
        ],
      ),
    );
  }

  return {
    broadness,
    task_hints: taskHints,
    tokens,
    candidates: sortCandidates(candidates.filter((item) => item.score > 0)).slice(0, 40),
  };
}

export function summarizeCandidateSet(set: ContextCandidateSet): ContextCandidateSummary {
  const counts: Record<CandidateKind, number> = {
    node: 0,
    memory: 0,
    rule: 0,
    skill: 0,
    recent_activity: 0,
  };
  for (const candidate of set.candidates) {
    counts[candidate.kind] += 1;
  }
  return {
    broadness: set.broadness,
    task_hints: set.task_hints,
    token_count: set.tokens.length,
    counts,
    top: set.candidates.slice(0, set.broadness === "narrow" ? 8 : 14),
  };
}
