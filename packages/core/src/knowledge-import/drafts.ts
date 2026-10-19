// SPDX-License-Identifier: Apache-2.0
//
// Turn a project's instruction files into memory drafts, word for word.
//
// Splits on H1/H2 headings; routes headings that look like paths
// (`/apps/mobile`, `apps/api`) to the matching node; everything else lands at
// the workspace root. Pure: no I/O, so the renderer can use it too. The caller
// writes the drafts into its own store (Pathrule Cloud's for a Cloud workspace,
// the local SQLite store for a local one).
//
// Heuristic for "path-like" heading: must contain at least one "/" separator
// and only contain path-safe characters. A single word like "Overview" is
// treated as a prose heading, not a path.

import type { KnowledgeSource } from "./discovery.js";

export interface MemoryDraft {
  /** Workspace-relative path, leading-slash form. "/" means the root node. */
  nodePath: string;
  title: string;
  content: string;
}

const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
const PATH_LIKE_RE = /^\/?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\/?$/;

function isPathLike(heading: string): boolean {
  const t = heading.trim();
  if (t === "/" || t === "") return false;
  return PATH_LIKE_RE.test(t);
}

function normalisePath(heading: string): string {
  const trimmed = heading.trim().replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

interface Section {
  level: 1 | 2;
  heading: string;
  body: string[];
}

/**
 * A fenced-code-block opener: three or more backticks or tildes, optionally
 * indented, optionally followed by an info string. Returns the fence marker so
 * the closer can be matched by the same character and at least the same length,
 * which is what CommonMark requires and what keeps a ```` block containing ```
 * from closing early.
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/;

/**
 * Split into H1/H2 sections, ignoring anything inside a fenced code block.
 *
 * Shell comments (`# install deps`) inside a ```bash block are NOT headings.
 * Claude Code applies the same rule to its own `@import` parsing. Without this,
 * a plain Setup section with a code block shattered into memories titled after
 * shell comments, and the fence lines landed in different memories, so the
 * markdown was broken too. Brownfield CLAUDE.md files are full of code blocks,
 * so this fired on essentially every real import.
 */
/**
 * Line indices covered by a CLOSED fenced block, as a boolean per line.
 *
 * Matching openers to closers up front (rather than tracking state in one pass)
 * is what makes an UNTERMINATED fence harmless: it never opens a block, so the
 * headings after it stay reachable. A missing closing fence is a common
 * authoring slip, and letting it swallow the rest of the file would silently
 * collapse the user's whole document into a single memory.
 */
function fencedLines(lines: string[]): boolean[] {
  const inFence = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; start: number } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(FENCE_RE);
    if (!m) continue;
    const marker = m[1]!;

    if (open === null) {
      open = { marker, start: i };
      continue;
    }
    // A closer is the same character, at least as long, with no info string.
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && m[2] === "") {
      for (let j = open.start; j <= i; j += 1) inFence[j] = true;
      open = null;
    }
  }
  return inFence;
}

function splitSections(input: string): { preamble: string; sections: Section[] } {
  const lines = input.split(/\r?\n/);
  const inFence = fencedLines(lines);
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const m = inFence[i] ? null : line.match(HEADING_RE);
    if (m && (m[1] === "#" || m[1] === "##")) {
      if (current) sections.push(current);
      current = { level: m[1].length as 1 | 2, heading: m[2]!, body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);
  return { preamble: preamble.join("\n"), sections };
}

function bodyText(body: string[]): string {
  return body.join("\n").trim();
}

/**
 * A discovered knowledge source, in the shape this importer needs. The import is
 * type-only, so this module stays free of fs.
 */
export type ImportableSource = Pick<
  KnowledgeSource,
  "path" | "kind" | "content" | "suggestedNodePath"
>;

/**
 * Turn discovered sources into memory drafts.
 *
 * Two things this gets right that the old single-file importer did not:
 *
 *   - A source's node path comes from WHERE IT LIVES. A nested
 *     `packages/api/CLAUDE.md` describes `/packages/api`, so its sections land
 *     there instead of all being flattened onto the root.
 *   - Titles are prefixed by origin for anything that is not a root instruction
 *     file, because "Overview" from `docs/adr/007-queues.md` and "Overview" from
 *     `CLAUDE.md` are different facts and must not collide.
 *
 * `document` sources are deliberately NOT imported wholesale: a roadmap or a
 * generated architecture dump is mostly derivable from the repo, and importing
 * it would bury the conventions that are not. Callers present those for the user
 * to pick from instead.
 */
export function importDiscoveredSources(sources: readonly ImportableSource[]): MemoryDraft[] {
  const drafts: MemoryDraft[] = [];

  for (const source of sources) {
    if (source.kind === "document") continue; // proposed to the user, not auto-imported

    const isRootInstruction = source.kind === "instruction" && source.suggestedNodePath === "/";
    for (const draft of importClaudeMd(source.content)) {
      // The importer defaults everything to "/" plus whatever path-like headings
      // it found. Re-anchor to the source's own directory so a nested file's
      // knowledge is attributed to that package.
      const nodePath =
        draft.nodePath === "/"
          ? source.suggestedNodePath
          : joinNodePath(source.suggestedNodePath, draft.nodePath);

      drafts.push({
        nodePath,
        title: isRootInstruction ? draft.title : `${originLabel(source)}: ${draft.title}`,
        content: draft.content,
      });
    }
  }

  return drafts;
}

/** "/packages/api" + "/src" → "/packages/api/src"; root stays as given. */
function joinNodePath(base: string, child: string): string {
  if (base === "/" || base === "") return child;
  const trimmedChild = child.replace(/^\/+/, "");
  return trimmedChild === "" ? base : `${base.replace(/\/+$/, "")}/${trimmedChild}`;
}

/** A short, stable label for where a draft came from. */
function originLabel(source: ImportableSource): string {
  const base = source.path.slice(source.path.lastIndexOf("/") + 1);
  switch (source.kind) {
    case "decision-record":
      return `ADR ${base}`;
    case "tool-rule":
      return base;
    default:
      return source.path;
  }
}

export function importClaudeMd(raw: string): MemoryDraft[] {
  if (!raw || raw.trim() === "") return [];

  const { preamble, sections } = splitSections(raw);
  const drafts: MemoryDraft[] = [];

  const preambleText = preamble.trim();
  if (preambleText && sections.length > 0) {
    drafts.push({
      nodePath: "/",
      title: "Imported CLAUDE.md (intro)",
      content: preambleText,
    });
  }

  if (sections.length === 0) {
    const content = raw.trim();
    if (content === "") return [];
    drafts.push({ nodePath: "/", title: "Imported CLAUDE.md", content });
    return drafts;
  }

  for (const sec of sections) {
    const heading = sec.heading.trim();
    const content = bodyText(sec.body);
    if (isPathLike(heading)) {
      drafts.push({
        nodePath: normalisePath(heading),
        title: "Imported from CLAUDE.md",
        content: content || "(imported section — body was empty)",
      });
    } else {
      drafts.push({
        nodePath: "/",
        title: heading,
        content: content || "(imported section — body was empty)",
      });
    }
  }
  return drafts;
}

// ── Which drafts a store still lacks ─────────────────────────────────────────
//
// Shared by every writer (the Cloud setup, the local setup), so
// "already imported" means the same thing whichever store holds the workspace.
// A draft counts as present when a memory with its exact title exists, archived
// or soft-deleted included: a section a person removed must not come back the
// next time setup runs. Exact titles work because the importer prefixes every
// non-root title by origin, so an imported memory keeps the title it was
// written with.

/**
 * When setup imports. `missing` writes every draft whose title the workspace has
 * never had (a new workspace, or an explicit request). `ifEmpty` writes only
 * into a workspace with no memories, rules or skills, so binding an existing
 * workspace again never brings back what someone removed.
 */
export type InstructionImportMode = "missing" | "ifEmpty";

/** The drafts one importable source turns into. */
export interface SourceDrafts {
  path: string;
  drafts: MemoryDraft[];
}

/** Drafts grouped by source. `document` sources are never imported verbatim, so they are left out. */
export function draftsBySource(sources: readonly ImportableSource[]): SourceDrafts[] {
  return sources
    .filter((source) => source.kind !== "document")
    .map((source) => ({ path: source.path, drafts: importDiscoveredSources([source]) }));
}

/** Which sources the workspace holds completely, and which it does not. */
export function splitByPresence(
  bySource: readonly SourceDrafts[],
  present: ReadonlySet<string>,
): { inPathrule: string[]; notImported: string[] } {
  const inPathrule: string[] = [];
  const notImported: string[] = [];
  for (const source of bySource) {
    (source.drafts.every((draft) => present.has(draft.title)) ? inPathrule : notImported).push(
      source.path,
    );
  }
  return { inPathrule, notImported };
}

/**
 * The drafts whose title the workspace has never had. A root CLAUDE.md and a
 * root .claude/CLAUDE.md can share a heading; the first one wins.
 */
export function missingDrafts(
  bySource: readonly SourceDrafts[],
  present: ReadonlySet<string>,
): MemoryDraft[] {
  const missing = new Map<string, MemoryDraft>();
  for (const draft of bySource.flatMap((source) => source.drafts)) {
    if (!present.has(draft.title) && !missing.has(draft.title)) missing.set(draft.title, draft);
  }
  return [...missing.values()];
}
