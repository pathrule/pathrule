// SPDX-License-Identifier: Apache-2.0
// What a knowledge search asks and how items answer it, for the Local UI API's `knowledge.search` and
// `knowledge.searchAll` (@pathrule/protocol/local-ui-api.ts): the folder a request names, the needle,
// an item's score and the order results come in. Local ranks a workspace's items with it
// (./workspace-routes.ts, ./search-all-route.ts) and Pathrule Cloud the candidates its D1 query
// pre-filters (the knowledge search of Pathrule Cloud), so both backends answer alike. No I/O here.
import {
  KNOWLEDGE_SEARCH_PATH_MAX,
  type KnowledgeKind,
  type KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";

const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];
const MAX_QUERY_CHARS = 500;
const MAX_PATH_CHARS = 1024;
/** How many words a store pre-filters by at most; the score decides the rest. */
const MAX_PREFILTER_TERMS = 8;

/** A list row's body: whitespace collapsed, at most 160 characters. */
export function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** A search limit between 1 and `max` (100 unless given); 20 when none is given. */
export function clampLimit(limit: number | undefined, max = 100): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** How well an item matches a lower-cased needle: title first, then path, then body. */
export function scoreItem(
  item: { title: string; preview: string; path: string | null },
  needle: string,
): number {
  const title = item.title.toLowerCase();
  const previewText = item.preview.toLowerCase();
  const path = item.path?.toLowerCase() ?? "";
  let score = 0;
  if (title === needle) score += 100;
  if (title.includes(needle)) score += 30;
  if (path.includes(needle)) score += 15;
  if (previewText.includes(needle)) score += 10;
  return score;
}

/**
 * A workspace-relative folder path: starts with "/", no "." or ".." segment, no backslash, no
 * control character. Returned without repeated or trailing slashes ("/" for the root).
 */
export function workspacePath(value: unknown, bad: (message: string) => Error): string {
  if (typeof value !== "string") throw bad("path must be a string.");
  if (value.trim().length === 0) throw bad("path must not be empty.");
  if (value.length > MAX_PATH_CHARS) throw bad(`path is longer than ${MAX_PATH_CHARS} characters.`);
  if (!value.startsWith("/")) throw bad('path must be workspace-relative and start with "/".');
  if (value.includes("\\")) throw bad("path must not contain a backslash.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw bad("path must not contain control characters.");
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw bad('path must not contain "." or ".." segments.');
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** What one search asks, validated. */
export interface KnowledgeSearch {
  /** The query, trimmed and lower-cased; "" (with a folder) lists the folder. */
  needle: string;
  /** Only items attached at this folder or below; null searches the whole workspace. */
  folder: string | null;
  kinds: KnowledgeKind[];
  limit: number;
}

/**
 * The search a request body asks for: `query`, `path`, `kinds` and `limit` as `knowledge.search` and
 * `knowledge.searchAll` take them. The caller refuses fields the route does not take.
 */
export function parseKnowledgeSearch(
  input: Record<string, unknown>,
  bad: (message: string) => Error,
  maxLimit: number,
): KnowledgeSearch {
  if (typeof input.query !== "string") throw bad("query must be a string.");
  if (input.query.length > MAX_QUERY_CHARS) {
    throw bad(`query is longer than ${MAX_QUERY_CHARS} characters.`);
  }
  let folder: string | null = null;
  if (input.path !== undefined) {
    if (typeof input.path === "string" && input.path.length > KNOWLEDGE_SEARCH_PATH_MAX) {
      throw bad(`path is longer than ${KNOWLEDGE_SEARCH_PATH_MAX} characters.`);
    }
    folder = workspacePath(input.path, bad);
  }
  const needle = input.query.trim().toLowerCase();
  // Only a folder makes an empty query mean something: everything in it.
  if (!needle && folder === null) throw bad("query must not be empty.");
  let kinds: KnowledgeKind[] = [...KINDS];
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0) {
      throw bad("kinds must be a non-empty list.");
    }
    kinds = [
      ...new Set(
        input.kinds.map((kind: unknown) => {
          if (typeof kind !== "string" || !KINDS.includes(kind as KnowledgeKind)) {
            throw bad(`kind must be one of ${KINDS.join(", ")}.`);
          }
          return kind as KnowledgeKind;
        }),
      ),
    ];
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== "number" || !Number.isInteger(input.limit))
  ) {
    throw bad("limit must be an integer.");
  }
  return { needle, folder, kinds, limit: clampLimit(input.limit as number | undefined, maxLimit) };
}

/** Whether an item is attached at `folder` or below, by any of its paths ("/" holds every item). */
export function inFolder(item: Pick<KnowledgeListItem, "path" | "paths">, folder: string): boolean {
  if (folder === "/") return true;
  const paths = item.paths ?? (item.path === null ? [] : [item.path]);
  return paths.some((path) => path === folder || path.startsWith(`${folder}/`));
}

/** Case-insensitive first, then exact, by UTF-16 code units: the same order on every machine. */
function byText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

type Ranked = KnowledgeListItem & { score: number; workspaceName?: string };

/**
 * The order results come in. A query: best score first, then the latest change. A folder listing
 * (no query): by path, then title. Across workspaces, the workspace's name breaks a tie; the id last.
 */
export function searchOrder(needle: string): (a: Ranked, b: Ranked) => number {
  return (a, b) =>
    (needle
      ? b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
      : byText(a.path ?? "", b.path ?? "") || byText(a.title, b.title)) ||
    byText(a.workspaceName ?? "", b.workspaceName ?? "") ||
    byText(a.id, b.id);
}

/**
 * The items that answer `search`, scored and in order (all of them: the caller takes `limit`). With
 * a query an item scores by `scoreItem` and one scoring 0 is left out; a folder listing scores 1.
 */
export function rankKnowledge<T extends KnowledgeListItem>(
  items: readonly T[],
  search: Pick<KnowledgeSearch, "needle" | "folder">,
): Array<T & { score: number }> {
  const { needle, folder } = search;
  const inside = folder === null ? items : items.filter((item) => inFolder(item, folder));
  const scored = inside.map((item) => ({ ...item, score: needle ? scoreItem(item, needle) : 1 }));
  return scored.filter((item) => item.score > 0).sort(searchOrder(needle));
}

/**
 * Words any item that scores above 0 for `needle` contains in its title, a path or its body, so a
 * store can pre-filter by them (a superset; `rankKnowledge` still decides). Lower-cased, at most 8,
 * longest first; none for a needle a store cannot filter by.
 *
 * A word is a run of characters that lower-case alike everywhere: ASCII, or characters with no case
 * (CJK, digits). A store compares them with an ASCII-only lower() (SQLite's) after mapping the two
 * characters whose lower case is ASCII, "İ" (to "i̇") and the Kelvin sign (to "k"); any other cased
 * letter breaks a word, so "Straße" or "çay" still match whatever their case.
 */
export function prefilterTerms(needle: string): string[] {
  const terms = new Set<string>();
  let run = "";
  const end = () => {
    if (run) terms.add(run);
    run = "";
  };
  for (const char of needle.toLowerCase()) {
    const ascii = char.charCodeAt(0) < 0x80;
    const caseless = char.toUpperCase() === char && char.toLowerCase() === char;
    if (/\s/u.test(char) || (!ascii && (!caseless || /\p{M}/u.test(char)))) end();
    else run += char;
  }
  end();
  return [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_PREFILTER_TERMS);
}
