// SPDX-License-Identifier: Apache-2.0
//
// Pure matchers for hook-index lookups.
//
// Given a hook-index.json and an incoming tool call (absolute file_path),
// walk from the most specific node path up to root, collecting every memory
// and rule scoped to an ancestor path. Pure functions — no I/O, easy to test.

import type { HookIndex, HookSemanticCandidate, MemoryStub, RuleStub } from "@pathrule/protocol/hook-index.js";
import { semanticTagScore } from "./semantic-tags.js";
import { pathsEqual, pathStartsWith } from "@pathrule/protocol/path-compare.js";

/**
 * Convert an absolute path to a workspace-relative node path.
 * Returns '/' for the workspace root, null if the absolute path is outside.
 *
 *   toRelative('/Users/me/repo/packages/app/src/x.ts', '/Users/me/repo')
 *     → '/packages/app/src/x.ts'
 */
export function toRelative(absolutePath: string, workspaceRoot: string): string | null {
  if (!absolutePath) return null;
  if (pathsEqual(absolutePath, workspaceRoot)) return "/";
  if (!pathStartsWith(absolutePath, workspaceRoot)) return null;
  // pathStartsWith honours case-insensitive FS; slice by the original
  // workspaceRoot length to preserve absolutePath's actual case.
  const prefix = workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/";
  return "/" + absolutePath.slice(prefix.length);
}

/**
 * Walk from `startPath` up through every ancestor to '/'.
 * Yields paths in order: most specific first.
 *
 *   ancestorPaths('/packages/app/src/store') →
 *     ['/packages/app/src/store', '/packages/app/src', '/packages/app', '/packages', '/']
 */
export function ancestorPaths(startPath: string): string[] {
  if (!startPath || startPath === "/") return ["/"];
  const parts = startPath.split("/").filter((p) => p.length > 0);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    out.push("/" + parts.slice(0, i).join("/"));
  }
  out.push("/");
  return out;
}

export interface MatchOptions {
  /** Cap on returned items per kind; defaults to 3 to keep context tight. */
  limit?: number;
}

/**
 * Collect memories tagged to any ancestor of `relativePath`. Deduplicated
 * by memory id. Closer matches come first.
 */
export function matchMemoriesForPath(
  index: HookIndex,
  relativePath: string,
  opts: MatchOptions = {},
): MemoryStub[] {
  const limit = opts.limit ?? 3;
  const seen = new Set<string>();
  const results: MemoryStub[] = [];

  for (const ancestor of ancestorPaths(relativePath)) {
    const bucket = index.path_memories[ancestor];
    if (!bucket) continue;
    for (const m of bucket) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      results.push(m);
      if (results.length >= limit) return results;
    }
  }

  return results;
}

/**
 * Every rule whose SCOPE covers `relativePath`: folder-scoped rules on any ancestor
 * path, plus project-scoped rules (always in effect). Deduplicated, path-closest
 * first, then project rules.
 *
 * Applicability lives here once, on purpose. Enforcement and context both need the
 * same answer to "does this rule apply?", and two walks would eventually disagree
 * about it.
 */
function collectApplicableRules(index: HookIndex, relativePath: string): RuleStub[] {
  const seen = new Set<string>();
  const results: RuleStub[] = [];

  for (const ancestor of ancestorPaths(relativePath)) {
    const bucket = index.path_rules[ancestor];
    if (!bucket) continue;
    for (const r of bucket) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      results.push(r);
    }
  }

  for (const r of index.project_rules) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    results.push(r);
  }

  return results;
}

/**
 * Rules to SHOW for `relativePath`: priority-sorted (high → medium → low) and cut to
 * the context budget. This is a display decision, and the cut is the point of it.
 */
export function matchRulesForPath(
  index: HookIndex,
  relativePath: string,
  opts: MatchOptions = {},
): RuleStub[] {
  const limit = opts.limit ?? 5;
  const results = collectApplicableRules(index, relativePath);

  // Stable priority sort: high first. The walk already preserved path-closeness.
  const priorityRank: Record<RuleStub["priority"], number> = { high: 0, medium: 1, low: 2 };
  results.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  return results.slice(0, limit);
}

/**
 * Rules to CHECK an Edit/Write against: every applicable rule carrying a compiled
 * constraint. Unbudgeted and unsorted, and that is the whole point.
 *
 * `matchRulesForPath` exists to bound how much text gets injected, so it ranks by
 * priority and truncates. Feeding the deny check from that list made enforcement a
 * function of the display budget: a medium-priority strict rule that lost the priority
 * race was never regex-tested, so an approved constraint silently stopped blocking.
 * Measured on rule 33 (`Never use cursor: pointer`): position 28 of 34 candidates
 * against a limit of 12, and position 19 of 25 project rules alone, so NO path in that
 * workspace could reach the check.
 *
 * The `filterRulesByRelevance` bypass at "enforcement === strict → always keep" does
 * not save it: that exempts strict rules from the relevance filter, which runs AFTER
 * this cut.
 *
 * No limit here. A cap is exactly what broke it, and the set is self-limiting: a rule
 * only enters it by carrying a trusted, active constraint that compiled.
 *
 * Either compiled half admits a rule. `block_path` is the half for a constraint whose
 * subject is WHERE a file is rather than what it contains, so requiring a content
 * pattern here would make every path-only atom invisible to this side while
 * pathrule-hook.js still denied on it, which is the one divergence that must not exist.
 */
export function matchEnforcementRulesForPath(index: HookIndex, relativePath: string): RuleStub[] {
  return collectApplicableRules(index, relativePath).filter(
    (r) => r.enforcement === "strict" && (r.block_pattern != null || r.block_path != null),
  );
}

/**
 * Match fail patterns against a path using glob-style prefix check.
 * Glob supports trailing `**` wildcard; anything else is treated as prefix.
 */
export function matchFailPatterns(
  index: HookIndex,
  relativePath: string,
  opts: MatchOptions = {},
): NonNullable<HookIndex["fail_patterns"]> {
  const limit = opts.limit ?? 2;
  const patterns = index.fail_patterns ?? [];
  const out: NonNullable<HookIndex["fail_patterns"]> = [];
  for (const p of patterns) {
    if (pathMatchesGlob(relativePath, p.path_glob)) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ─── relevance filtering ──────────────────────────────────────────────────────
//
// The runtime JS hook mirrors these functions; keep them in sync. The source
// of truth for the algorithm is THIS file — tests cover it here.

const STOPWORDS = new Set<string>([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "about",
  "up",
  "down",
  "out",
  "over",
  "into",
  "not",
  "no",
  "yes",
  "you",
  "your",
  "our",
  "their",
  "its",
  "it",
  "we",
  "us",
  "they",
  "function",
  "const",
  "let",
  "var",
  "import",
  "export",
  "return",
  "async",
  "await",
  // Turkish
  "bir",
  "ve",
  "ile",
  "için",
  "bu",
  "şu",
  "o",
  "ben",
  "sen",
  "biz",
  "siz",
  "onlar",
  "var",
  "yok",
  "olan",
  "olarak",
  "değil",
  "daha",
  "çok",
  "az",
  "her",
  "hiç",
  "bazı",
  "en",
  "de",
  "da",
  "ki",
  "ama",
  "veya",
  "ya",
  "sadece",
  "nasıl",
  "neden",
  "nedir",
  "şey",
  "yine",
  "gibi",
]);

/** Bilingual (en+tr) tokenizer. Drops stopwords and tokens <3 chars. */
export function tokenize(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lowered = String(text).toLowerCase();
  const raw = lowered.split(/[^a-z0-9ğıöşüçâîûñé]+/i);
  for (const t of raw) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Count shared tokens between a pre-tokenised context set and a target string. */
export function keywordOverlap(contextTokens: Set<string>, target: string): number {
  const targetTokens = tokenize(target);
  let hits = 0;
  for (const t of targetTokens) if (contextTokens.has(t)) hits++;
  return hits;
}

const MEMORY_GENERIC_PATH_TOKENS = new Set<string>([
  "app",
  "apps",
  "src",
  "source",
  "component",
  "components",
  "content",
  "package",
  "packages",
  "pathrule",
  "file",
  "update",
  "patch",
  "begin",
  "end",
  "old",
  "new",
  "tsx",
  "jsx",
  "typescript",
  "javascript",
]);

function pathDepth(nodePath: string | null | undefined): number {
  if (!nodePath || nodePath === "/") return 0;
  return nodePath.split("/").filter(Boolean).length;
}

/** Memory relevance ignores broad path/build tokens that create false positives. */
export function memoryRelevanceScore(contextTokens: Set<string>, target: string): number {
  const targetTokens = tokenize(target);
  let score = 0;
  for (const t of targetTokens) {
    if (!contextTokens.has(t)) continue;
    if (MEMORY_GENERIC_PATH_TOKENS.has(t)) continue;
    score += 1;
  }
  return score;
}

function memoryThreshold(memory: MemoryStub, baseThreshold: number): number {
  return pathDepth(memory.node_path) <= 2 ? Math.max(baseThreshold, 2) : baseThreshold;
}

/** Priority-adjusted overlap threshold. Higher-priority rules need less proof. */
export function relevanceThreshold(priority: RuleStub["priority"]): number {
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

export interface FilterRulesParams {
  rules: RuleStub[];
  /** Tokens from the tool call's input (file path + new content). */
  contextTokens: Set<string>;
  /** Internal semantic tags inferred from the tool call. */
  contextSemanticTags?: string[];
  /** Raw context text — used for literal symbol-substring matching. */
  contextText: string;
  /** Rule ids already injected earlier in this session. */
  seenRuleIds: Set<string>;
}

/**
 * Apply relevance + dedup filtering to matched rules.
 *
 * Precedence (top-down, first hit wins):
 *   1. `enforcement === "strict"` → always keep (bypasses everything).
 *   2. `seenRuleIds.has(r.id)` → drop (session dedup).
 *   3. `r.symbols?.length > 0` → keep only if ≥1 symbol is a literal substring
 *      of `contextText`. Priority-independent hard gate.
 *   4. Fallback: keyword overlap ≥ `relevanceThreshold(priority)` → keep, else drop.
 */
export function filterRulesByRelevance(params: FilterRulesParams): RuleStub[] {
  const { rules, contextTokens, contextSemanticTags, contextText, seenRuleIds } = params;
  const kept: RuleStub[] = [];
  for (const r of rules) {
    if (r.enforcement === "strict") {
      kept.push(r);
      continue;
    }
    if (seenRuleIds.has(r.id)) continue;
    if (r.symbols && r.symbols.length > 0) {
      const hit = r.symbols.some((s) => s.length > 0 && contextText.includes(s));
      if (!hit) continue;
      kept.push(r);
      continue;
    }
    const overlap = keywordOverlap(contextTokens, `${r.name} ${r.preview}`);
    const tagPart = semanticTagScore(contextSemanticTags, r.semantic_tags);
    const threshold = relevanceThreshold(r.priority);
    if (overlap < threshold && !(overlap >= 1 && tagPart.score >= 4)) continue;
    kept.push(r);
  }
  return kept;
}

export interface FilterMemoriesParams {
  memories: MemoryStub[];
  contextTokens: Set<string>;
  /** Internal semantic tags inferred from the tool call. */
  contextSemanticTags?: string[];
  seenMemoryIds: Set<string>;
  /** Minimum keyword overlap required. Defaults to 1 (loose). */
  threshold?: number;
  /** Cap returned memories after relevance sorting. */
  limit?: number;
}

/** Dedup + loose keyword relevance for memories (no priority axis). */
export function filterMemoriesByRelevance(params: FilterMemoriesParams): MemoryStub[] {
  const {
    memories,
    contextTokens,
    contextSemanticTags,
    seenMemoryIds,
    threshold = 1,
    limit,
  } = params;
  const kept: Array<{ memory: MemoryStub; score: number; depth: number; index: number }> = [];
  let index = 0;
  for (const m of memories) {
    const currentIndex = index++;
    if (seenMemoryIds.has(m.id)) continue;
    const score = memoryRelevanceScore(contextTokens, `${m.title} ${m.preview}`);
    const tagPart = semanticTagScore(contextSemanticTags, m.semantic_tags);
    if (score < memoryThreshold(m, threshold) && !(score >= 1 && tagPart.score >= 4)) continue;
    kept.push({
      memory: m,
      score: score * 3 + tagPart.score,
      depth: pathDepth(m.node_path),
      index: currentIndex,
    });
  }
  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.index - b.index;
  });
  const ranked = kept.map((item) => item.memory);
  return typeof limit === "number" ? ranked.slice(0, limit) : ranked;
}

export interface SelectSemanticMemoryCandidatesParams {
  index: HookIndex;
  contextTokens: Set<string>;
  contextSemanticTags?: string[];
  seenMemoryIds: Set<string>;
  excludeMemoryIds?: Set<string>;
  limit?: number;
}

/**
 * Lightweight hook semantic hints. This is not a vector search; it
 * reuses the hook-index title/preview/tags so the hot path stays offline.
 * Returned candidates are title-only nudges; agents must call read_memory(id)
 * before treating one as an answer source.
 */
export function selectSemanticMemoryCandidates(
  params: SelectSemanticMemoryCandidatesParams,
): HookSemanticCandidate[] {
  const limit = params.limit ?? 3;
  if (limit <= 0) return [];

  const exclude = params.excludeMemoryIds ?? new Set<string>();
  const seen = new Set<string>();
  const ranked: Array<{
    candidate: HookSemanticCandidate;
    score: number;
    depth: number;
    index: number;
  }> = [];
  let index = 0;

  for (const bucket of Object.values(params.index.path_memories ?? {})) {
    for (const memory of bucket) {
      const currentIndex = index++;
      if (!memory?.id) continue;
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      if (params.seenMemoryIds.has(memory.id)) continue;
      if (exclude.has(memory.id)) continue;

      const lexicalScore = keywordOverlap(
        params.contextTokens,
        `${memory.title} ${memory.preview} ${memory.node_path}`,
      );
      const tagPart = semanticTagScore(params.contextSemanticTags, memory.semantic_tags);
      const score = lexicalScore * 3 + tagPart.score;
      if (score < 3) continue;

      const confidence: HookSemanticCandidate["confidence"] =
        lexicalScore >= 2 || tagPart.score >= 4 ? "high" : "medium";
      ranked.push({
        candidate: {
          id: memory.id,
          title: memory.title,
          node_path: memory.node_path,
          confidence,
          reason:
            tagPart.matches.length > 0
              ? `semantic_tag:${tagPart.matches.slice(0, 2).join(",")}`
              : "title_or_preview_overlap",
        },
        score,
        depth: pathDepth(memory.node_path),
        index: currentIndex,
      });
    }
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.index - b.index;
  });

  return ranked.slice(0, limit).map((item) => item.candidate);
}

/**
 * Auto-extract symbol hints from a rule body. Looks at markdown
 * inline-code spans (`` `foo.bar` ``), drops stopwords, caps at `limit`.
 * Returns undefined when nothing qualifies (keeps RuleStub minimal).
 */
export function extractRuleSymbols(content: string, limit = 8): string[] | undefined {
  if (!content) return undefined;
  const out = new Set<string>();
  const re = /`([^`\n]{2,80})`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const captured = match[1];
    if (!captured) continue;
    const raw = captured.trim();
    if (!raw) continue;
    // Accept anything that looks like a symbol: letters, numbers, dots, colons,
    // slashes, dashes, parens. Drops prose like "see docs".
    if (!/^[\w.\-/:()@<>[\]=]+$/.test(raw)) continue;
    if (raw.length < 3) continue;
    out.add(raw);
    if (out.size >= limit) break;
  }
  return out.size > 0 ? [...out] : undefined;
}

function pathMatchesGlob(path: string, glob: string): boolean {
  if (!glob) return false;
  if (glob === path) return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
  }
  if (glob.endsWith("/*")) {
    const prefix = glob.slice(0, -2);
    const rest = path.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : null;
    return rest !== null && !rest.includes("/");
  }
  // Plain prefix fallback
  if (path === glob) return true;
  return path.startsWith(glob.endsWith("/") ? glob : glob + "/");
}

/**
 * Format a hook additionalContext string from matched memories/rules.
 * Keeps output compact (~300-800 chars) so Claude's context isn't polluted.
 * Returns null when there's nothing to say.
 */
export function formatInjectionContext(params: {
  relativePath: string;
  memories: MemoryStub[];
  rules: RuleStub[];
  semanticCandidates?: HookSemanticCandidate[];
  failPatterns?: NonNullable<HookIndex["fail_patterns"]>;
}): string | null {
  const { relativePath, memories, rules, semanticCandidates = [], failPatterns = [] } = params;
  if (
    memories.length === 0 &&
    rules.length === 0 &&
    semanticCandidates.length === 0 &&
    failPatterns.length === 0
  ) {
    return null;
  }

  const lines: string[] = [];
  lines.push(`📌 Pathrule context for ${relativePath}:`);
  lines.push("");

  const strictRules = rules.filter((r) => r.enforcement === "strict");
  const advisoryRules = rules.filter((r) => r.enforcement !== "strict");

  if (strictRules.length > 0) {
    lines.push("**🚨 Strict rules (violating these blocks your tool call):**");
    for (const r of strictRules) {
      lines.push(`- **${r.name}** — ${r.preview}`);
    }
    lines.push("");
  }

  if (advisoryRules.length > 0) {
    lines.push("**Rules in scope:**");
    for (const r of advisoryRules) {
      lines.push(`- ${r.name} (${r.priority}) — ${r.preview}`);
    }
    lines.push("");
  }

  if (memories.length > 0) {
    lines.push("**Memories scoped to this path:**");
    for (const m of memories) {
      lines.push(`- ${m.title} — ${m.preview}`);
    }
    lines.push("");
  }

  if (semanticCandidates.length > 0) {
    lines.push("**Possible semantic memory candidates:**");
    for (const candidate of semanticCandidates.slice(0, 3)) {
      lines.push(
        `- ${candidate.title} (id: ${candidate.id}, ${candidate.confidence}, ${candidate.node_path})`,
      );
    }
    lines.push("Read the memory body before using a semantic candidate as evidence.");
    lines.push("");
  }

  if (failPatterns.length > 0) {
    lines.push("**⚠️ Recent failure patterns here:**");
    for (const f of failPatterns) {
      lines.push(`- ${f.warning_text} (seen ${f.count}×)`);
    }
    lines.push("");
  }

  lines.push(
    "(Use Pathrule first: read full content via `pathrule_read_memory(id)` / `pathrule_read_rule(id)` when relevant; fall back only after Pathrule has no match.)",
  );

  return lines.join("\n");
}

// ─── Filename-scoped body preload ──────────────────────────────────────────────

const PROMPT_FILENAME_RE =
  /\b[\w.-]+\.(json|ts|tsx|js|jsx|md|sql|ya?ml|toml|css|scss|html|py|rs|go|rb|php|sh)\b/gi;

/**
 * Extract filename tokens from a user prompt. Deduped, original case preserved.
 * Used by the hook at UserPromptSubmit to decide whether to inject a full
 * memory body inline.
 */
export function extractFilenameTokensFromPrompt(prompt: string): string[] {
  const matches = prompt.match(PROMPT_FILENAME_RE);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

export type InlineResolution =
  | { action: "none" }
  | { action: "inline"; memoryId: string; title: string; body: string }
  | { action: "nudge"; candidates: Array<{ id: string; title: string }> };

export interface ResolveInlineParams {
  tokens: string[];
  index: HookIndex;
  /** Workspace-relative cwd path (e.g. "/apps/mobile/brands/beltur"). */
  cwdRelative: string;
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (!ancestor || ancestor === "/" || ancestor === "") return true;
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : ancestor + "/";
  return descendant.startsWith(prefix);
}

/**
 * Look up filename tokens in the hook index's reverse filename_index. When a
 * single candidate matches (after cwd-ancestor disambiguation), emit an
 * inline action; when multiple remain, emit a nudge; otherwise `none`.
 *
 * Max 1 inline id returned across all tokens (deterministic pick: first
 * token alphabetically that yields a clean single match).
 */
export function resolveFilenameInline(params: ResolveInlineParams): InlineResolution {
  const filenameIndex = params.index.filename_index;
  if (!filenameIndex) return { action: "none" };

  // Flatten all memories into a lookup by id so we can find title + body.
  const memoryById = new Map<string, MemoryStub>();
  for (const stubs of Object.values(params.index.path_memories)) {
    for (const stub of stubs) memoryById.set(stub.id, stub);
  }

  const sortedTokens = [...params.tokens].sort();
  for (const token of sortedTokens) {
    const candidateIds = filenameIndex[token] ?? [];
    if (candidateIds.length === 0) continue;

    // cwd-scoped disambiguation: prefer candidates whose node_path is an
    // ancestor of (or equal to) the current cwd path.
    const scopedIds = candidateIds.filter((id) => {
      const mem = memoryById.get(id);
      if (!mem) return false;
      return isAncestorPath(mem.node_path, params.cwdRelative);
    });

    const effective = scopedIds.length > 0 ? scopedIds : candidateIds;

    if (effective.length > 1) {
      const candidates = effective
        .map((id) => memoryById.get(id))
        .filter((m): m is MemoryStub => Boolean(m))
        .map((m) => ({ id: m.id, title: m.title }));
      if (candidates.length === 0) continue;
      return { action: "nudge", candidates };
    }

    const only = effective[0];
    if (!only) continue;
    const mem = memoryById.get(only);
    if (!mem) continue;
    if (!mem.body) {
      return { action: "nudge", candidates: [{ id: mem.id, title: mem.title }] };
    }
    return { action: "inline", memoryId: mem.id, title: mem.title, body: mem.body };
  }

  return { action: "none" };
}
