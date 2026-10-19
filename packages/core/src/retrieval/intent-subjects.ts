// SPDX-License-Identifier: Apache-2.0
//
// Intent subjects for episode retrieval.
//
// pathrule_relevant_work_episodes takes p_intent_subjects and refuses to do
// anything when that array is empty:
//
//   IF p_intent_subjects IS NULL OR cardinality(p_intent_subjects) = 0 THEN RETURN;
//
// Nothing in the codebase produced that array. get-context.ts read it off the
// router decision through a cast (`(routing.decision as { intent_subjects?: ... })`),
// but neither DeterministicRoute nor routing-types ever carried the field, so the
// value was `[]` on every call and the RPC returned before scoring a single
// episode. Measured 2026-08-24: the whole episode surface was unreachable for this
// reason alone, on top of two other independent defects.
//
// So this module exists to fill that array, and it is deliberately dumb. The
// score that decides relevance lives in SQL:
//
//   subject_overlap_score  Jaccard over an exact-match INTERSECT
//   path_overlap_score     bidirectional prefix on the current node path
//   zero-signal filter     WHERE NOT (s_overlap = 0 AND p_overlap = 0)
//
// Because path overlap alone can carry a row, subjects do not have to match for
// retrieval to work. They have to EXIST. Getting a term wrong costs a little
// ranking; producing nothing costs the entire feature, which is what happened.

/** Filler tokens that carry no retrieval signal. Turkish first, then English. */
const STOP_WORDS = new Set<string>([
  // Turkish
  "için",
  "gibi",
  "daha",
  "ama",
  "veya",
  "ile",
  "bir",
  "bu",
  "şu",
  "var",
  "yok",
  "olan",
  "nasıl",
  "neden",
  "hangi",
  "sonra",
  "önce",
  "kadar",
  "yani",
  "diye",
  "mi",
  "mu",
  "işte",
  "şey",
  "çok",
  // English
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "you",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "but",
  "any",
  "all",
  "can",
  "will",
  "should",
  "would",
  "could",
  "please",
  "make",
  "made",
  "does",
  "did",
  "why",
  "how",
  "what",
  "when",
  "where",
  "which",
]);

/** Upper bound on the array handed to SQL. Ranking never needs more. */
const DEFAULT_LIMIT = 8;

const MIN_TERM_LENGTH = 3;

/**
 * Split an identifier or file name into kebab-case subject candidates.
 *
 * Episode subjects come from pathrule_log_activity, where agents write short
 * kebab-case keywords: `activity-bar`, `figma-bridge`, `i18n`. A prompt naming
 * `ActivityBar.tsx` should therefore contribute `activity-bar`, because the SQL
 * comparison is an exact-match INTERSECT and `activitybar` would never meet it.
 */
function kebabCandidates(token: string): string[] {
  const bare = token.replace(/\.[A-Za-z0-9]+$/, "");
  // Split camelCase / PascalCase runs: ActivityBar -> ["Activity", "Bar"].
  const parts = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((p) => p.length > 0);
  if (parts.length < 2) return [];
  const kebab = parts.join("-").toLowerCase();
  return kebab.length >= MIN_TERM_LENGTH ? [kebab] : [];
}

export interface DeriveIntentSubjectsOptions {
  /** Maximum subjects returned. Defaults to 8. */
  limit?: number;
  /**
   * Workspace-relative paths the router already identified for this turn. Their
   * file names are strong subject candidates: a turn about ActivityBar.tsx is a
   * turn about `activity-bar` whether or not the user typed it that way.
   */
  primaryFiles?: readonly string[];
}

/**
 * Derive the intent subjects for one turn.
 *
 * Returns an empty array only when there is genuinely nothing to say (no intent
 * text and no primary files). Callers should treat a non-empty result as the
 * precondition for episode retrieval, because the RPC does.
 */
export function deriveIntentSubjects(
  intent: string | undefined | null,
  options: DeriveIntentSubjectsOptions = {},
): string[] {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (term: string): void => {
    const t = term.trim().toLowerCase();
    if (t.length < MIN_TERM_LENGTH) return;
    if (STOP_WORDS.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  // File names first: they are the most specific thing about a turn, and the
  // router already decided they matter.
  for (const file of options.primaryFiles ?? []) {
    const base = file.split("/").filter(Boolean).pop();
    if (!base) continue;
    for (const candidate of kebabCandidates(base)) push(candidate);
    push(base.replace(/\.[A-Za-z0-9]+$/, ""));
  }

  const text = (intent ?? "").trim();
  if (text.length > 0) {
    // A bare token may itself be an identifier or a path the user typed inline.
    for (const raw of text.split(/\s+/)) {
      const last = raw.split("/").filter(Boolean).pop() ?? raw;
      for (const candidate of kebabCandidates(last)) push(candidate);
    }
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      push(token);
    }
  }

  return out.slice(0, limit);
}

/**
 * Resolve the subjects for a turn from whatever the router produced, falling back
 * to derivation.
 *
 * Kept here rather than inline at the call sites because both the MCP tool path
 * and the host's context builder need the identical precedence, and the whole
 * reason episodes were unreachable is that one call site quietly resolved to [].
 */
export function resolveIntentSubjects(
  routerDecision: unknown,
  intent: string | undefined | null,
  primaryFiles: readonly string[] | undefined,
): string[] {
  const fromRouter = (routerDecision as { intent_subjects?: string[] } | undefined)
    ?.intent_subjects;
  if (Array.isArray(fromRouter) && fromRouter.length > 0) return fromRouter;
  return deriveIntentSubjects(intent, { primaryFiles: primaryFiles ?? [] });
}
