// SPDX-License-Identifier: Apache-2.0

export type SemanticTag =
  | "frontend"
  | "backend"
  | "database"
  | "infra"
  | "test"
  | "docs"
  | "config"
  | "ui"
  | "design-system"
  | "i18n"
  | "electron"
  | "mcp"
  | "hook"
  | "router"
  | "performance"
  | "supabase"
  | "edge-function"
  | "rls"
  | "auth"
  | "billing"
  | "stripe"
  | "migration"
  | "security"
  | "release"
  | "tree"
  | "suggestions"
  | "modal"
  | "skill-package"
  | "workspace"
  | "activity"
  | "cache";

const TAG_RULES: Array<{ tag: SemanticTag; patterns: RegExp[] }> = [
  {
    tag: "frontend",
    patterns: [
      /\/packages\/app\b/i,
      /\b(frontend|front-end|renderer|react|tsx|jsx|component|components|screen|page|view)\b/i,
    ],
  },
  {
    tag: "backend",
    patterns: [/\/packages\/mcp-server\b/i, /\b(backend|server|service|api|ipc|worker|queue)\b/i],
  },
  {
    tag: "database",
    patterns: [/\b(database|postgres|postgrest|db|sql|rpc|rls|schema)\b/i, /\/supabase\b/i],
  },
  {
    tag: "infra",
    patterns: [/\b(infra|deploy|deployment|cloudflare|r2|notarize|notarized|updater)\b/i],
  },
  {
    tag: "test",
    patterns: [/\b(test|tests|vitest|playwright|typecheck|lint|eslint|smoke)\b/i],
  },
  {
    tag: "docs",
    patterns: [/\b(docs|readme|claude\.md|agents\.md|llms\.txt|documentation)\b/i],
  },
  {
    tag: "config",
    patterns: [/\b(config|env|toml|yaml|yml|json|settings|preferences)\b/i],
  },
  {
    tag: "ui",
    patterns: [
      /\b(ui|ux|modal|popover|dialog|button|badge|tab|tree|layout|design|onboarding)\b/i,
      /\b(tasarim|tasarım|ekran|sayfa|gorunum|görünüm|yerlesim|yerleşim|rozet)\b/i,
    ],
  },
  {
    tag: "design-system",
    patterns: [/\b(design system|design-system|tokens?|theme|tailwind|shadcn|visual language)\b/i],
  },
  { tag: "i18n", patterns: [/\b(i18n|translation|translations|locale|localization|hardcoded)\b/i] },
  { tag: "electron", patterns: [/\b(electron|main process|renderer|tray|native menu)\b/i] },
  {
    tag: "mcp",
    patterns: [/\b(mcp|model context protocol|get_context|read_memory|tool surface)\b/i],
  },
  {
    tag: "hook",
    patterns: [/\b(hook|hooks|pretooluse|posttooluse|userpromptsubmit|sessionstart)\b/i],
  },
  { tag: "router", patterns: [/\b(router|routing|route|deterministic_route|ai-route)\b/i] },
  {
    tag: "performance",
    patterns: [/\b(performance|latency|timeout|telemetry|cache|optimize|hiz|hız)\b/i],
  },
  { tag: "supabase", patterns: [/\b(supabase|edge function|edge-function)\b/i, /\/supabase\b/i] },
  { tag: "edge-function", patterns: [/\b(edge function|edge-function|functions\/[a-z0-9_-]+)\b/i] },
  { tag: "rls", patterns: [/\b(rls|row level security|policy|policies)\b/i] },
  { tag: "auth", patterns: [/\b(auth|jwt|session|login|keychain|oauth)\b/i] },
  {
    tag: "billing",
    patterns: [/\b(billing|subscription|checkout|invoice|payment|usage limit)\b/i],
  },
  { tag: "stripe", patterns: [/\b(stripe|webhook|checkout session|paymentintent)\b/i] },
  { tag: "migration", patterns: [/\b(migration|migrations|schema change|alter table)\b/i] },
  {
    tag: "security",
    patterns: [/\b(security|secret|service role|rls|jwt|permission|access check)\b/i],
  },
  { tag: "release", patterns: [/\b(release|ship|publish|version bump|notarized|signed)\b/i] },
  { tag: "tree", patterns: [/\b(tree|collapse|expand|node tree|treetoolbar)\b/i] },
  {
    tag: "suggestions",
    patterns: [/\b(suggestion|suggestions|suggestionstab|refresh suggestion)\b/i],
  },
  { tag: "modal", patterns: [/\b(modal|dialog|popover|sheet)\b/i] },
  {
    tag: "skill-package",
    patterns: [/\b(skill package|skill-package|skillpackagetree|skillpackageviewer)\b/i],
  },
  { tag: "workspace", patterns: [/\b(workspace|project root|repo root|node path|root path)\b/i] },
  {
    tag: "activity",
    patterns: [/\b(activity|activities|recent activity|log_activity|activity log)\b/i],
  },
  { tag: "cache", patterns: [/\b(cache|cached|etag|warm|cold|ttl)\b/i] },
];

const KNOWN_TAGS = new Set<SemanticTag>(TAG_RULES.map((rule) => rule.tag));
const GENERIC_TAGS = new Set<SemanticTag>([
  "frontend",
  "backend",
  "database",
  "infra",
  "ui",
  "config",
  "docs",
  "test",
]);

function normalizeExistingTag(tag: string): SemanticTag | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return KNOWN_TAGS.has(normalized as SemanticTag) ? (normalized as SemanticTag) : null;
}

export interface InferSemanticTagsInput {
  text?: string | null;
  path?: string | null;
  existingTags?: string[] | null;
  limit?: number;
}

export function inferSemanticTags(input: InferSemanticTagsInput): SemanticTag[] {
  const text = `${input.path ?? ""} ${input.text ?? ""}`;
  const out = new Set<SemanticTag>();

  for (const tag of input.existingTags ?? []) {
    const normalized = normalizeExistingTag(tag);
    if (normalized) out.add(normalized);
  }

  for (const rule of TAG_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) out.add(rule.tag);
  }

  return Array.from(out).slice(0, input.limit ?? 8);
}

export function semanticTagsOrInfer(
  semanticTags: readonly string[] | null | undefined,
  input: InferSemanticTagsInput,
): SemanticTag[] {
  const normalized = inferSemanticTags({
    existingTags: semanticTags ? Array.from(semanticTags) : [],
    limit: input.limit,
  });
  return normalized.length > 0 ? normalized : inferSemanticTags(input);
}

export function semanticTagMatches(
  contextTags: readonly string[] | undefined,
  targetTags: readonly string[] | undefined,
): SemanticTag[] {
  if (!contextTags || !targetTags || contextTags.length === 0 || targetTags.length === 0) {
    return [];
  }
  const context = new Set(
    contextTags
      .map((tag) => normalizeExistingTag(tag))
      .filter((tag): tag is SemanticTag => Boolean(tag)),
  );
  const matches = targetTags
    .map((tag) => normalizeExistingTag(tag))
    .filter((tag): tag is SemanticTag => Boolean(tag))
    .filter((tag) => context.has(tag));
  return Array.from(new Set(matches));
}

export function semanticTagScore(
  contextTags: readonly string[] | undefined,
  targetTags: readonly string[] | undefined,
): { score: number; matches: SemanticTag[] } {
  const matches = semanticTagMatches(contextTags, targetTags);
  if (matches.length === 0) return { score: 0, matches };
  if (matches.length === 1 && GENERIC_TAGS.has(matches[0]!)) return { score: 0, matches: [] };
  return { score: Math.min(12, matches.length * 4), matches };
}
