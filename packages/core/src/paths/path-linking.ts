// SPDX-License-Identifier: Apache-2.0
// A repo-relative file path: two or more segments ending in a file extension.
//
// The previous rule was a fixed directory list
// (`packages|apps|src|docs|supabase|types|scripts|config|public|tests?`) — which
// is Pathrule's own tree, `supabase` included. Measured against eight real
// paths it matched exactly one, ours: Xcode `Sources/`, Rails `app/models/`,
// Flutter `lib/`, Unity `Assets/`, Go `cmd/` and `internal/` all found nothing,
// so path linking quietly did nothing for most projects.
//
// Anchoring on "has a file extension" instead of "starts with a known folder"
// works in any stack and keeps prose out: `read/write`, `and/or`, `3/4` and
// `TCP/IP` have no extension, so they never match.
const PATH_PATTERN = /(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+/g;

/** A path mention preceded by a scheme (http://, file://) is a URL, not a repo path. */
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * English constructions that use a slash but name no path. Accepting
 * extension-less paths (`packages/api`, `Sources/Networking`) means prose has to
 * be excluded explicitly — and this list is defensible where a directory-name
 * list was not: idiomatic slash pairs are a closed set, project layouts are
 * not. A miss here costs a spurious path suggestion; a miss the other way costs
 * the knowledge entirely.
 */
const PROSE_SLASH_PAIRS = new Set([
  "and/or",
  "either/or",
  "he/she",
  "his/her",
  "in/out",
  "input/output",
  "on/off",
  "pass/fail",
  "read/write",
  "s/he",
  "true/false",
  "w/o",
  "yes/no",
]);

/** `3/4`, `24/7` — numeric ratios. */
const NUMERIC_RATIO = /^\d+(?:\/\d+)+$/;
/** `TCP/IP`, `CI/CD`, `A/B` — all-caps abbreviations. */
const CAPS_ABBREVIATION = /^[A-Z]{1,6}(?:\/[A-Z]{1,6})+$/;

function looksLikeProse(value: string): boolean {
  if (PROSE_SLASH_PAIRS.has(value.toLowerCase())) return true;
  if (NUMERIC_RATIO.test(value)) return true;
  if (CAPS_ABBREVIATION.test(value)) return true;
  return false;
}

export function normalizeNodePath(path: string | undefined, fallback = "/"): string {
  if (!path) return fallback;
  const clean = path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean || clean === ".") return fallback;
  return `/${clean}`;
}

export function parentNodePath(path: string): string {
  const clean = normalizeNodePath(path);
  const withoutSlash = clean.replace(/^\/+/, "");
  if (!withoutSlash.includes("/")) return clean;
  return normalizeNodePath(withoutSlash.slice(0, withoutSlash.lastIndexOf("/")));
}

export function extractPathMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PATH_PATTERN)) {
    // Skip anything that is part of a URL: the scheme sits just before the match.
    const lead = text.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (URL_LIKE.test(lead)) continue;

    const value = match[0].replace(/[),.;:]+$/, "");
    if (value.length <= 2 || looksLikeProse(value)) continue;
    seen.add(value);
  }
  return [...seen].slice(0, 20);
}

export function bestNodePathFromMentions(mentions: string[], fallback: string): string {
  const first = mentions.find(Boolean);
  if (!first) return fallback;
  return parentNodePath(first);
}

export function uniquePaths(paths: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const normalized = normalizeNodePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}
