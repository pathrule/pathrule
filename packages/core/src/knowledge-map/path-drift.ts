// SPDX-License-Identifier: Apache-2.0
//
// Knowledge that names a file the checkout has since moved away from. A memory says the runbook is
// `docs/runbook.md`; a teammate copies it to `docs/oncall/runbook.md`, points the README there and leaves
// the old file. Nothing in the memory is false on its face, so nothing flags it, and the next agent writes
// to the old file. Measured on PathruleBench's capability scenarios (2026-10-18): with the runbook moved
// that way, the Pathrule arm wrote a later session's row to the old file in most chains.
//
// Read from the checkout and its history, no model, no words of any language, three signals:
//   renamed  the named file is gone and git recorded its rename to a file that exists;
//   pointer  the named file is now a short note naming another file of the same name, or its folder;
//   copy     a near-identical file of the same name exists elsewhere, some other file names that one and
//            not the original (a README link, a script's path), and nothing names the original any more
//            (a file naming both describes the move). A twin still in use, an open-source copy beside a
//            proprietary one, is named by something and so is not drift.
// A gone file with no recorded rename is not drift: knowledge abbreviates paths ("cli/commands/x.ts"
// for "packages/cloud/src/cli/commands/x.ts") and names files of other branches, and a same-named file
// elsewhere was measured to be a different file as often as the same one (this repository, 2026-10-18).
// Each finding becomes a notice in the session digest, which the hook gives on every session's first
// prompt, a one-line warning when an agent edits the old file (a knowledge_gaps stub scoped to that file),
// and a refresh request on the memory. The digest is the one that reaches shell work: measured on the
// same scenarios, agents wrote the runbook with `cat >>` and Python heredocs, which no edit hook sees.
import { createHash } from "node:crypto";
import type { KnowledgeGapStub } from "@pathrule/protocol/hook-index.js";
import { extractPathAnchors, resolveItemAnchors } from "./anchors.js";

export interface DriftMemory {
  id: string;
  title: string;
  content: string;
  /** The owner's path; "" or "/" when unknown. */
  node_path: string;
}

/** The checkout as drift detection reads it: repo-relative file paths, a reader that may refuse (null), and
 * where a gone file was renamed to, when the history says. */
export interface DriftTree {
  files: readonly string[];
  read(path: string): string | null;
  renamedTo?(path: string): string | null;
}

export type PathDriftKind = "renamed" | "pointer" | "copy";

export interface PathDrift {
  memoryId: string;
  title: string;
  /** The file the memory names. */
  anchor: string;
  /** The file the checkout points to instead. */
  current: string;
  kind: PathDriftKind;
  /** For `copy`: the file that names `current` and not `anchor`. */
  evidence: string | null;
}

export const PATH_DRIFT_LINE_MAX = 280;
/** Line-set overlap at which two files of the same name count as one file in two places. */
const MIN_COPY_SIMILARITY = 0.6;
/** A file this short that names a same-named file elsewhere is a pointer, not content. */
const POINTER_MAX_LINES = 4;
const POINTER_MAX_CHARS = 600;
/** Below this many distinct lines two files are alike by being near-empty (`__init__.py`), not by being one file. */
const MIN_COPY_LINES = 3;
/** Files read when looking for what names a copy: enough for a repository's docs and scripts. */
const MAX_REFERRER_FILES = 5000;
/** Agent instruction files repeat what memories say; a mention there is the memory, not the checkout. */
const INSTRUCTION_FILE =
  /(?:^|\/)(?:CLAUDE|AGENTS|GEMINI)\.md$|(?:^|\/)\.(?:claude|cursor|pathrule|github\/instructions)\//;
const TEXT_FILE =
  /\.(?:md|mdx|txt|rst|adoc|json|ya?ml|toml|ini|cfg|py|go|[cm]?[jt]sx?|rb|rs|java|kt|sh|mk)$|(?:^|\/)(?:Makefile|Dockerfile)$/;
const FILE_LIKE = /\/[^/]*\.[A-Za-z0-9]{1,8}$/;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function lineSet(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function similarity(a: string, b: string): number {
  const x = lineSet(a),
    y = lineSet(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const l of x) if (y.has(l)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/** Mentions a path as a whole token, not as the tail of a longer one (`docs/runbook.md` in `x/docs/runbook.md`). */
function names(text: string, path: string): boolean {
  let at = text.indexOf(path);
  while (at >= 0) {
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + path.length] ?? "";
    if (!/[\p{L}\p{N}_./-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)) return true;
    at = text.indexOf(path, at + 1);
  }
  return false;
}

class TreeIndex {
  readonly tree: DriftTree;
  readonly has: Set<string>;
  readonly byName = new Map<string, string[]>();
  private readonly cache = new Map<string, string | null>();
  constructor(tree: DriftTree) {
    this.tree = tree;
    this.has = new Set(tree.files);
    for (const f of tree.files) {
      const list = this.byName.get(baseName(f));
      if (list) list.push(f);
      else this.byName.set(baseName(f), [f]);
    }
  }
  read(path: string): string | null {
    if (!this.cache.has(path)) this.cache.set(path, this.tree.read(path));
    return this.cache.get(path)!;
  }
  /** The first file other than `x` and `y` that names `x` and not `y`, reading only text files; undefined past the budget. */
  namesOnly(x: string, y: string): string | null | undefined {
    let read = 0;
    for (const f of this.tree.files) {
      if (f === x || f === y || INSTRUCTION_FILE.test(f) || !TEXT_FILE.test(f)) continue;
      if (++read > MAX_REFERRER_FILES) return undefined;
      const text = this.read(f);
      if (text !== null && names(text, x) && !names(text, y)) return f;
    }
    return null;
  }
}

function driftOf(tree: TreeIndex, anchor: string): Omit<PathDrift, "memoryId" | "title"> | null {
  if (!tree.has.has(anchor)) {
    const moved = tree.tree.renamedTo?.(anchor) ?? null;
    return moved && tree.has.has(moved)
      ? { anchor, current: moved, kind: "renamed", evidence: null }
      : null;
  }
  const sameName = (tree.byName.get(baseName(anchor)) ?? []).filter((f) => f !== anchor);
  if (sameName.length === 0) return null;
  const text = tree.read(anchor);
  if (text === null) return null;
  const lines = text.split("\n").filter((l) => l.trim()).length;
  if (lines <= POINTER_MAX_LINES && text.length <= POINTER_MAX_CHARS) {
    // A note names the new file, or the folder it now lives in ("moved to internal/catalogue").
    const named = extractPathAnchors(text).filter((p) => p !== anchor);
    const target = sameName.find((f) =>
      named.some((p) => f === p || f.slice(0, f.lastIndexOf("/")) === p),
    );
    if (target) return { anchor, current: target, kind: "pointer", evidence: null };
  }
  if (lineSet(text).size < MIN_COPY_LINES) return null;
  for (const candidate of sameName) {
    const other = tree.read(candidate);
    if (other === null || similarity(text, other) < MIN_COPY_SIMILARITY) continue;
    const evidence = tree.namesOnly(candidate, anchor);
    if (evidence && tree.namesOnly(anchor, candidate) === null)
      return { anchor, current: candidate, kind: "copy", evidence };
  }
  return null;
}

/** Every memory's file references the checkout has moved away from, one finding per memory and file. */
export function detectPathDrift(memories: readonly DriftMemory[], tree: DriftTree): PathDrift[] {
  const index = new TreeIndex(tree);
  const out: PathDrift[] = [];
  const seen = new Map<string, Omit<PathDrift, "memoryId" | "title"> | null>();
  for (const m of memories) {
    const node = m.node_path.replace(/^\/+|\/+$/g, "");
    const reported = new Set<string>();
    for (const raw of extractPathAnchors(m.content)) {
      if (!FILE_LIKE.test(`/${raw}`)) continue;
      // The memory's own reading of the reference: as written, or relative to its node when that names a file.
      const readings = node ? resolveItemAnchors([raw], [node]) : [raw];
      const anchor = readings.find((r) => index.has.has(r)) ?? raw;
      if (reported.has(anchor)) continue;
      if (!seen.has(anchor)) seen.set(anchor, driftOf(index, anchor));
      const found = seen.get(anchor);
      if (!found) continue;
      reported.add(anchor);
      out.push({ memoryId: m.id, title: m.title, ...found });
    }
  }
  return out;
}

/** What the checkout shows, in one clause: "README.md now names docs/oncall/runbook.md, a copy of it". */
function finding(d: PathDrift): string {
  if (d.kind === "copy") return `${d.evidence} now names ${d.current}, a copy of it`;
  if (d.kind === "pointer") return `it now points to ${d.current}`;
  return `git shows it was renamed to ${d.current}`;
}

/** The warning given when an agent writes the old file. */
export function renderPathDriftLine(d: PathDrift): string {
  const build = (title: string) =>
    `memory "${title}" names ${d.anchor}, but ${finding(d)}. Write to ${d.current}, then update the memory (pathrule_update_memory).`;
  const full = build(d.title);
  if (full.length <= PATH_DRIFT_LINE_MAX) return full;
  const room = Math.max(8, d.title.length - (full.length - PATH_DRIFT_LINE_MAX) - 1);
  return build(`${d.title.slice(0, room).trimEnd()}…`).slice(0, PATH_DRIFT_LINE_MAX);
}

export const PATH_DRIFT_DIGEST_MAX = 5;

/** Why the checkout points elsewhere, in a few words for the digest. */
function shortWhy(d: PathDrift): string {
  if (d.kind === "copy") return `${d.evidence} names the new one`;
  if (d.kind === "pointer") return "the old file points there";
  return "git renamed it";
}

/** The session-start notice: one line per stale file, at most five, or null when nothing drifted. */
export function renderPathDriftDigest(drifts: readonly PathDrift[]): string | null {
  const byAnchor = new Map<string, PathDrift>();
  for (const d of drifts) if (!byAnchor.has(d.anchor)) byAnchor.set(d.anchor, d);
  if (byAnchor.size === 0) return null;
  const lines = [...byAnchor.values()]
    .slice(0, PATH_DRIFT_DIGEST_MAX)
    .map((d) => `- ${d.anchor} → ${d.current} (${shortWhy(d)})`);
  if (byAnchor.size > PATH_DRIFT_DIGEST_MAX)
    lines.push(`- and ${byAnchor.size - PATH_DRIFT_DIGEST_MAX} more`);
  return [
    "Pathrule: knowledge names files the checkout has moved away from. Use the current file, and update the memory (pathrule_update_memory):",
    ...lines,
  ].join("\n");
}

/** The reason recorded on the memory's refresh request. */
export function pathDriftReason(d: PathDrift): string {
  return `${d.anchor} looks moved: ${finding(d)}. Point the memory at the current file.`;
}

/** One stub per stale file, scoped to that file, so the hook warns the edit that writes it. */
export function pathDriftStubs(drifts: readonly PathDrift[]): KnowledgeGapStub[] {
  const out: KnowledgeGapStub[] = [];
  const seen = new Set<string>();
  for (const d of drifts) {
    if (seen.has(d.anchor)) continue;
    seen.add(d.anchor);
    const ref = `drift_${createHash("sha256").update(`drift:${d.anchor}\u0000${d.current}`).digest("hex").slice(0, 8)}`;
    out.push({ ref, scope: d.anchor, line: renderPathDriftLine(d) });
  }
  return out;
}
