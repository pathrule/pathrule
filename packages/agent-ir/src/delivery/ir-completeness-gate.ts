// SPDX-License-Identifier: Apache-2.0
/**
 * IR completeness gate (V47). Decides, deterministically and FAIL-CLOSED, whether a memory's compiled
 * Agent IR represents its operationally necessary meaning well enough to deliver INSTEAD of the prose body,
 * or whether the delivery must fall back to prose. `atom_count > 0` is deliberately NOT the test: a
 * PRECEDENCE/SELECTION memory whose IR kept only the winner ("use formatMoney") and dropped the loser
 * ("not Intl") has a non-zero atom count but has lost the relationship the agent needs, and must fall back.
 *
 * The gate reads only the SOURCE text and the ACTUAL agent-facing delivery (what Claude will see), never the
 * atom's internal evidence: V47 measured a case where the atom grounded on a span mentioning the loser while
 * the delivered projection kept only the winner, so judging the atom passed but the agent would never learn
 * to avoid the loser. No LLM judge. When in doubt, PROSE.
 *
 * Behavioral validation (V47, N=5 on IR-routed tasks): IR-first-with-this-gate matched full prose on every
 * task (FALSE_IR_READY = 0), and forcing IR past the gate on a gated-out memory reproduced a real compliance
 * regression the gate prevents.
 */

export interface IrCompletenessInput {
  /** Number of grounded, validated atoms compiled from the memory. */
  atomCount: number;
  /** The EXACT agent-facing delivery text (claim + nav + any receipt span), i.e. what Claude receives. */
  deliveredText: string;
  /** The source memory body (whitespace/markdown may be normalized; content must be intact). */
  sourceText: string;
}

export type IrCompletenessLevel = "FULL" | "PARTIAL" | "ZERO";
export interface IrCompletenessResult {
  decision: "IR" | "PROSE";
  level: IrCompletenessLevel;
  reason: string;
}

// Source markers that name a LOSER (a thing to avoid), and the token that follows them.
const REL_MARKER = /\b(takes precedence over|precedence over|instead of|rather than|do not use|must not use|prefer\b)/i;
const REL_LOSER_RE = /\b(?:takes precedence over|precedence over|instead of|rather than|not use|do not use|must not use|deprecated|over)\s+([A-Za-z_$][\w$.]{2,})/gi;
// Turkish puts the loser BEFORE its marker ("Intl yerine formatMoney", "moment'i kullanma"), so the
// token is captured on the left, with any apostrophe suffix ("'i", "'ı") dropped.
const REL_MARKER_TR = /(?<![\p{L}\p{N}_])(?:yerine|kullanma)/iu;
const REL_LOSER_TR_RE = /([\p{L}_$][\p{L}\p{N}_$.]{2,})(?:['’]\p{L}+)?\s+(?:yerine|kullanma)/giu;
// Source markers of an ORDERED multi-step procedure.
const PROC_MARKER = /\b(first,|, then\b|then,|next,|finally,|step \d|in order|all three|in this order)/i;
const PROC_MARKER_TR = /(?<![\p{L}\p{N}_])(?:ilk olarak|ardından|son olarak|sırasıyla|sırayla|adım \d|önce[^.\n]{0,80}sonra)/iu;
// Words that mark an operational sentence (one that changes what the agent should do).
const OP_SENTENCE = /\b(must|never|always|use|return|guard|prefer|throws|via|through|before|after|only)\b/;
// The Turkish equivalents, matched as word STARTS so suffixes still count ("kullanın", "çağırmadan").
const OP_SENTENCE_TR = /(?<![\p{L}\p{N}_])(?:kullan|asla|her zaman|mutlaka|zorunda|gerek|olmalı|yalnızca|sadece|önce|sonra|yerine|üzerinden|döndür|çağır)/u;

// Names the source writes in code form. Language-neutral on purpose: a loser that is an identifier,
// a file or a command is caught whatever language the sentence around it is in.
const INLINE_CODE_RE = /`([^`\n]{2,80})`/g;
const DOTTED_RE = /(?<![\w$./-])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;
const CAMEL_RE = /(?<![\w$])(?:[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z])[A-Za-z0-9]*/g;
const SNAKE_RE = /(?<![\w$])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g;
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]{2,})\(/g;
const FILE_RE = /(?<![\w./-])(?:[\w-]+\/)+[\w-]+\.[A-Za-z0-9]{1,5}(?![\w])/g;

/**
 * Every name the source writes in code form, lowercased and deduplicated. An abbreviation like `e.g`
 * is not a name.
 */
function namedLiterals(src: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.trim().replace(/[.,;:]+$/, "");
    if (t.length < 3) return;
    const parts = t.split(".");
    if (parts.length > 1 && parts.every((p) => p.length <= 2)) return;
    out.add(t.toLowerCase());
  };
  // Outermost forms first, each blanked once taken, so `Intl.NumberFormat` is one name and not also
  // `NumberFormat`, and `src/money.js` is one path and not also `money.js`.
  let rest = src;
  for (const re of [INLINE_CODE_RE, FILE_RE, DOTTED_RE]) {
    for (const m of rest.matchAll(re)) add(m[1] ?? m[0]);
    rest = rest.replace(re, " ");
  }
  for (const re of [CAMEL_RE, SNAKE_RE]) for (const m of rest.matchAll(re)) add(m[0]);
  for (const m of rest.matchAll(CALL_RE)) add(m[1] ?? "");
  return [...out];
}

/**
 * Does the delivery carry this name? A dotted name is carried by its full form or by its head, the same
 * allowance the relationship check makes (`Intl` carries `Intl.NumberFormat`).
 */
function carries(delivered: string, literal: string): boolean {
  if (delivered.includes(literal)) return true;
  if (/\s/.test(literal) || !literal.includes(".") || literal.includes("/")) return false;
  const head = literal.split(".")[0] ?? "";
  return head.length >= 3 && delivered.includes(head);
}

/**
 * Decide IR vs prose fallback for one memory. Deterministic and fail-closed.
 */
export function irCompletenessGate(input: IrCompletenessInput): IrCompletenessResult {
  if (input.atomCount <= 0) return { decision: "PROSE", level: "ZERO", reason: "zero_atoms" };
  const src = input.sourceText;
  const delivered = input.deliveredText.toLowerCase();

  // 1. Relationship primitives: if the source names a loser, the DELIVERY must still carry it, or the agent
  // cannot know what to avoid. (winner-only delivery of a PRECEDENCE/SELECTION is PARTIAL.)
  const losers = new Set<string>();
  const collect = (re: RegExp): void => {
    for (const m of src.matchAll(re)) { const l = (m[1] ?? "").replace(/[.,;].*$/, "").trim().toLowerCase(); if (l.length >= 3) losers.add(l); }
  };
  if (REL_MARKER.test(src)) collect(new RegExp(REL_LOSER_RE.source, "gi"));
  if (REL_MARKER_TR.test(src)) collect(new RegExp(REL_LOSER_TR_RE.source, "giu"));
  for (const loser of losers) {
    const head = loser.split(".")[0] ?? loser;
    if (!delivered.includes(loser) && !delivered.includes(head)) {
      return { decision: "PROSE", level: "PARTIAL", reason: `relationship_loser_missing:${loser}` };
    }
  }

  // 2. Ordered procedure: a single delivered unit cannot carry an ordered sequence.
  if ((PROC_MARKER.test(src) || PROC_MARKER_TR.test(src)) && input.atomCount < 2) {
    return { decision: "PROSE", level: "PARTIAL", reason: "procedure_steps_missing" };
  }

  // 3. Named code: every identifier, call, file or inline-code span the source names must still be in the
  // delivery. This is the language-neutral half of check 1: a loser written as code is caught even when the
  // sentence marking it as the loser is in a language the markers above do not know.
  for (const literal of namedLiterals(src)) {
    if (!carries(delivered, literal)) {
      return { decision: "PROSE", level: "PARTIAL", reason: `named_literal_missing:${literal}` };
    }
  }

  // 4. Source coverage: the delivery must represent at least half of the source's operational sentences.
  const opSent = src.split(/[.\n]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 18 && (OP_SENTENCE.test(s) || OP_SENTENCE_TR.test(s)));
  if (opSent.length >= 2) {
    const covered = opSent.filter((s) => {
      const key = s.slice(0, 28);
      if (delivered.includes(key)) return true;
      return key.split(" ").filter((w) => w.length > 3 && delivered.includes(w)).length >= 2;
    }).length;
    if (covered / opSent.length < 0.5) return { decision: "PROSE", level: "PARTIAL", reason: `low_coverage:${covered}/${opSent.length}` };
  }

  return { decision: "IR", level: "FULL", reason: "sufficient" };
}
