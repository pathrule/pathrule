// SPDX-License-Identifier: Apache-2.0
//
// A changed decision, held to the edit that writes the old value. A memory that says "use `X` instead
// of `Y`" is compiled into a stub naming `Y`; when a Write or Edit's new content carries `Y`, the hook
// adds one line quoting the decision, once per session per decision. pathrule-hook.js carries an
// inline twin of selectChangedDecision (it may not import anything); a parity test pins the two.
//
// Measured on PathruleBench v3 (2026-10-16): the "new error types use errors.acme.io instead of
// errors.acme.dev" decision was saved and delivered in every chain, and in one chain of three the
// session-4 agent wrote `errors.acme.dev/gone` anyway. The rules file cannot see what is being written;
// the PreToolUse hook can. No model, nothing stored but the two values and the sentence.
import { createHash } from "node:crypto";
import type { ChangedDecisionStub } from "@pathrule/protocol/hook-index.js";

export const CHANGED_DECISION_LINE_MAX = 360;
/** A superseded value this short, or made of letters only, is a word, not a value. */
const MIN_VALUE_CHARS = 4;
/** "`X` … instead of … `Y`" and "instead of `Y` … `X`", the two ways people write it. */
const NEW_THEN_OLD = /`([^`\n]{1,120})`[^`\n.;]{0,60}?\binstead of\b[^`\n.;]{0,20}?`([^`\n]{1,120})`/gi;
const OLD_THEN_NEW = /\binstead of\b[^`\n.;]{0,20}?`([^`\n]{1,120})`[^`\n.;]{0,80}?`([^`\n]{1,120})`/gi;

interface MemoryLike {
  id: string;
  title: string;
  content: string;
  node_path: string;
}

const isValue = (s: string): boolean => s.length >= MIN_VALUE_CHARS && !/^[\p{L}\s]+$/u.test(s);

/** The sentence a match sits in, trimmed to the line budget. */
function sentenceAround(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf(". ", at), text.lastIndexOf("\n", at)) + 1;
  const endDot = text.indexOf(". ", at);
  const endNl = text.indexOf("\n", at);
  const ends = [endDot, endNl].filter((i) => i >= 0);
  const end = ends.length > 0 ? Math.min(...ends) + 1 : text.length;
  return text.slice(start, end).trim();
}

/** Scope: the memory's directory without the leading slash; "" for the root. A file path scopes to its directory. */
function scopeOf(nodePath: string): string {
  const clean = nodePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const last = clean.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]{1,8}$/.test(last) ? clean.split("/").slice(0, -1).join("/") : clean;
}

export function renderChangedDecisionLine(superseded: string, replacement: string, sentence: string, title: string): string {
  const head = `Pathrule: \`${superseded}\` was replaced by \`${replacement}\` (memory "${title}"): "`;
  const tail = `". The newer value for new work; the old one only where the decision keeps it.`;
  const room = CHANGED_DECISION_LINE_MAX - head.length - tail.length;
  if (room < 24) return `${head}${tail}`.slice(0, CHANGED_DECISION_LINE_MAX);
  const quote = sentence.length > room ? `${sentence.slice(0, room - 1).trimEnd()}…` : sentence;
  return `${head}${quote}${tail}`;
}

/** The stubs an index carries: one per memory and superseded value, in memory order. */
export function changedDecisionStubs(memories: readonly MemoryLike[]): ChangedDecisionStub[] {
  const out: ChangedDecisionStub[] = [];
  const seen = new Set<string>();
  for (const m of memories) {
    const text = m.content;
    const found: Array<{ replacement: string; superseded: string; at: number }> = [];
    for (const match of text.matchAll(NEW_THEN_OLD)) found.push({ replacement: match[1]!, superseded: match[2]!, at: match.index ?? 0 });
    for (const match of text.matchAll(OLD_THEN_NEW)) found.push({ replacement: match[2]!, superseded: match[1]!, at: match.index ?? 0 });
    for (const f of found) {
      const superseded = f.superseded.trim(), replacement = f.replacement.trim();
      if (!isValue(superseded) || superseded === replacement || replacement.includes(superseded)) continue;
      const key = `${m.id}\u0000${superseded}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ref: `cd_${createHash("sha256").update(key).digest("hex").slice(0, 8)}`,
        scope: scopeOf(m.node_path),
        superseded,
        line: renderChangedDecisionLine(superseded, replacement, sentenceAround(text, f.at), m.title),
      });
    }
  }
  return out;
}

/** New content without the lines a patch removes (Codex apply_patch arrives as the whole patch). */
export function writtenText(newString: string): string {
  return newString
    .split("\n")
    .filter((l) => !l.startsWith("-"))
    .join("\n");
}

/** The first undelivered stub whose scope holds the file and whose superseded value the edit writes. TS twin of the hook's selection. */
export function selectChangedDecision(
  index: { changed_decisions?: ChangedDecisionStub[] },
  relativeFilePath: string,
  newString: string,
  delivered: ReadonlySet<string>,
): ChangedDecisionStub | null {
  const path = relativeFilePath.replace(/^\/+/, "");
  const text = writtenText(newString);
  for (const stub of index.changed_decisions ?? []) {
    if (delivered.has(stub.ref)) continue;
    if (stub.scope && path !== stub.scope && !path.startsWith(`${stub.scope}/`)) continue;
    if (text.includes(stub.superseded)) return stub;
  }
  return null;
}
