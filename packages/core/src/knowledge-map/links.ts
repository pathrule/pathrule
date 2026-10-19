// SPDX-License-Identifier: Apache-2.0
//
// One link grammar for the Summary graph and the knowledge map.
//
// A body links to another item with `[[target]]` (alias `|` and heading `#` stripped, code
// ignored) or names a skill with `::skill-name`. Targets resolve in stages, in order:
//   exact        lowercased title or slug, or their kebab form
//   apostrophe   "user's" matches "users" (kebab-casing alone turns it into "user-s")
//   punctuation  every separator removed ("frame.html" matches "framehtml")
//   prefix       the one title slug that starts with the link ("turn-stall-watchdog")
//   subset       the one title whose words contain every word of the link
// Fuzzy matching is deliberately absent: the prototype's fuzzy stage resolved none of the
// 208 references it measured, and a near-miss is where wrong edges come from.

export type LinkStage = "exact" | "apostrophe" | "punctuation" | "prefix" | "subset";

export interface LinkTargetItem {
  id: string;
  kind: "memory" | "rule" | "skill";
  /** Memory title, rule name or skill name. */
  title: string;
  /** Explicit kebab-case slug, when the caller has one. */
  slug?: string;
}

export interface ResolvedLink {
  id: string;
  stage: LinkStage;
}

export interface LinkResolver {
  resolve(target: string): ResolvedLink | null;
}

const FENCE = /```[\s\S]*?```/g;
const INLINE = /`[^`]*`/g;
const WIKILINK = /\[\[([^\][]+)\]\]/g;
// Not after a word character or a colon (std::vector, fe80::1), and not followed by a colon
// (`::pathrule:package:<slug>` is a pattern import, not a skill).
const SKILL_REF = /(?<![A-Za-z0-9_:])::([a-z0-9][a-z0-9-]{2,})(?![a-z0-9:-])/g;
const FILLER = new Set(["and", "the", "a", "an", "of", "to"]);
const MIN_LOOSE_WORDS = 3;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const withoutApostrophes = (value: string): string => value.replace(/['’]/g, "");
const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const wordSet = (slug: string): Set<string> =>
  new Set(slug.split("-").filter((word) => word && !FILLER.has(word)));

/**
 * Link targets in a body: `[[target]]` outside fenced and inline code, then `::skill-name`
 * outside fenced code (skill names are usually written in backticks). Deduped
 * case-insensitively, first spelling and order kept. Skill refs keep their `::` prefix.
 */
export function extractLinkTargets(body: string | null | undefined): string[] {
  if (!body) return [];
  const noFence = body.replace(FENCE, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (target: string): void => {
    const key = target.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(target);
  };
  for (const match of noFence.replace(INLINE, " ").matchAll(WIKILINK)) {
    const target = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
    if (target.replace(/[.\s]/g, "") !== "") add(target);
  }
  for (const match of noFence.matchAll(SKILL_REF)) add(`::${match[1]}`);
  return out;
}

export function createLinkResolver(items: readonly LinkTargetItem[]): LinkResolver {
  const exact = new Map<string, string>();
  const apostrophe = new Map<string, string>();
  const squashed = new Map<string, string>();
  const skills = new Map<string, string>();
  const slugs: Array<{ id: string; slug: string; words: Set<string> }> = [];
  const first = (map: Map<string, string>, key: string, id: string): void => {
    if (key && !map.has(key)) map.set(key, id);
  };
  // Sorted by id so the first registration of a shared title is the same whatever order the
  // caller passes items in.
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const title = item.title.trim();
    for (const name of item.slug ? [title, item.slug.trim()] : [title]) {
      first(exact, name.toLowerCase(), item.id);
      first(exact, slugify(name), item.id);
    }
    const slug = slugify(withoutApostrophes(title));
    first(apostrophe, slug, item.id);
    first(squashed, squash(slug), item.id);
    if (item.kind === "skill") {
      first(skills, title.toLowerCase(), item.id);
      first(skills, slugify(title), item.id);
    }
    slugs.push({ id: item.id, slug, words: wordSet(slug) });
  }

  return {
    resolve(target) {
      if (target.startsWith("::")) {
        const id = skills.get(target.slice(2).toLowerCase());
        return id ? { id, stage: "exact" } : null;
      }
      const hit = exact.get(target.trim().toLowerCase()) ?? exact.get(slugify(target));
      if (hit) return { id: hit, stage: "exact" };
      const slug = slugify(withoutApostrophes(target));
      if (!slug) return null;
      const byApostrophe = apostrophe.get(slug);
      if (byApostrophe) return { id: byApostrophe, stage: "apostrophe" };
      const byPunctuation = squashed.get(squash(slug));
      if (byPunctuation) return { id: byPunctuation, stage: "punctuation" };
      // A short link is too generic to resolve by prefix or by shared words.
      if (slug.split("-").length < MIN_LOOSE_WORDS) return null;
      const prefixed = slugs.filter((s) => s.slug.startsWith(`${slug}-`));
      if (prefixed.length === 1) return { id: prefixed[0]!.id, stage: "prefix" };
      const wanted = wordSet(slug);
      if (wanted.size < MIN_LOOSE_WORDS) return null;
      const subset = slugs.filter((s) => [...wanted].every((word) => s.words.has(word)));
      return subset.length === 1 ? { id: subset[0]!.id, stage: "subset" } : null;
    },
  };
}
