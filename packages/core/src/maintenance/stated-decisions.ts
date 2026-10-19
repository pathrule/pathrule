// SPDX-License-Identifier: Apache-2.0
/**
 * What the person stated as lasting, in their own words, with no model and no agent tool call: a team
 * decision, a change of decision, a rule given with "from now on", "always" or "never", in any of the
 * languages `lasting-markers.ts` knows. The hook keeps every prompt in `user-words.jsonl`; this reads
 * what is new since the last pass, keeps the sentences that carry a lasting marker, and saves each at
 * the workspace root, quoted verbatim and typed, so the binding files carry it from the next session. A
 * statement a memory already makes (the agent saved it during the turn, in its own words) is not saved
 * again. Pasted material (long text, documents, code, lists) is never read: what it contains is not
 * the person's decision.
 *
 * Measured on PathruleBench v3 (2026-10-16): a decision stated in a prompt reached later sessions in two
 * chains of three; in the third the agent never saved it, and nothing else could. The capture is
 * structural (marker words and sentence shape), so it reads every project the same way and never
 * paraphrases: the memory is the person's sentence, in the person's language.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGroundedAtom, MAX_SPAN_CHARS, type CapturedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";
import { compiledMarkers, everydayRegex, splitSentences, strongMinimum, type CompiledMarkers } from "./lasting-markers.js";

/** The hook appends `{ sid, at, text }` here on every prompt. */
export const USER_WORDS_LEDGER = "user-words.jsonl";
/** How far into the ledger the last pass read, in bytes. */
export const USER_WORDS_CURSOR = "user-words.cursor";

const MAX_QUOTE_CHARS = 700;
/** A prompt longer than this, or shaped like a document, was pasted, not said: what it contains is not the person's decision. */
const MAX_TYPED_PROMPT_CHARS = 1500;
const PASTED_SHAPE = /^[[#<]|```|^#{1,3} |<system-reminder|^\s*[-*] .*\n\s*[-*] |(?:^|\s)\d+[-.)]\s[\s\S]*(?:^|\s)\d+[-.)]\s/m;
/** At most this many statements a prompt: a message that states more is a list, not a decision. */
const MAX_PER_PROMPT = 2;
const TITLE_CHARS = 72;
/** With no cursor yet, how far back the first pass reads: a workspace's months of prompts stay as they are. */
const FIRST_PASS_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Content words shared with an existing memory at this share mean it already says this. */
const SAME_STATEMENT_SHARE = 0.7;

export interface StatedDecision {
  /** The person's sentences, verbatim. */
  quote: string;
  kind: "decision" | "changed-decision";
  /** The language whose markers matched (BCP 47). */
  lang: string;
  sid: string | null;
  at: string | null;
}

interface Hit {
  m: CompiledMarkers;
  opens: boolean;
  changed: boolean;
}

/** True for a message a person typed; false for pasted material (long text, documents, code, lists). */
export function typedPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return text.length > 0 && !text.startsWith("/") && text.length <= MAX_TYPED_PROMPT_CHARS && !PASTED_SHAPE.test(text);
}

/** The script a sentence is written in settles a tie between languages that share a word (今後 in ja and zh). */
function scriptPrefers(sentence: string): string | null {
  if (/[\u3040-\u30ff]/.test(sentence)) return "ja";
  if (/[\uac00-\ud7af]/.test(sentence)) return "ko";
  if (/[\u4e00-\u9fff]/.test(sentence)) return "zh";
  if (/[\u0400-\u04ff]/.test(sentence)) return "ru";
  return null;
}

/** The language whose lasting marker the sentence carries; a strong word counts only in a long sentence. */
function lastingHit(sentence: string): Hit | null {
  if (/[?？]\s*$/.test(sentence)) return null;
  const lower = sentence.toLowerCase();
  const prefer = scriptPrefers(sentence);
  // Kana means Japanese, never Chinese; ideographs without kana mean Chinese, never Japanese.
  const excluded = prefer === "ja" ? "zh" : prefer === "zh" ? "ja" : null;
  const ordered = prefer ? [...compiledMarkers()].filter((m) => m.lang.code !== excluded).sort((a, b) => Number(b.lang.code === prefer) - Number(a.lang.code === prefer)) : compiledMarkers();
  let strong: Hit | null = null;
  const everyday = everydayRegex().test(lower);
  for (const m of ordered) {
    if (m.lasting?.test(lower)) return { m, opens: m.opener?.test(lower) ?? false, changed: m.changed?.test(lower) ?? false };
    if (!strong && !everyday && m.strong?.test(lower) && strongMinimum(m.lang, sentence)) strong = { m, opens: false, changed: false };
  }
  return strong;
}

/** An opener sentence that only announces ("one more team decision.") carries its statement in the next sentence. */
function announcesOnly(sentence: string, hit: Hit): boolean {
  if (!hit.opens || !hit.m.opener) return false;
  const rest = statement(sentence, hit.m.lang.code)
    .replace(new RegExp(`^(?:[\\p{L}']{1,4}\\s+){0,2}${hit.m.opener.source}`, "iu"), "")
    .replace(/[\s.。:：,、]+$/, "");
  return rest.length < 12;
}

/** The lasting statements in one prompt: consecutive lasting sentences form one quote; a new opener starts another. */
export function statedDecisions(prompt: string, meta: { sid?: string | null; at?: string | null } = {}): StatedDecision[] {
  const text = prompt.trim();
  if (!typedPrompt(text)) return [];
  const out: StatedDecision[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    let run: string[] = [];
    let first: Hit | null = null;
    let changed = false;
    const flush = () => {
      if (run.length === 0 || !first) return;
      out.push({ quote: run.join(" ").slice(0, MAX_QUOTE_CHARS).trim(), kind: changed ? "changed-decision" : "decision", lang: first.m.lang.code, sid: meta.sid ?? null, at: meta.at ?? null });
      run = [];
      first = null;
      changed = false;
    };
    let joinNext = false;
    for (const s of splitSentences(paragraph.replace(/\s*\n\s*/g, " "))) {
      const hit = lastingHit(s);
      if (!hit) {
        if (joinNext && run.length > 0) run.push(s);
        joinNext = false;
        flush();
        continue;
      }
      if (hit.opens) flush();
      if (!first) first = hit;
      changed = changed || hit.changed;
      run.push(s);
      joinNext = announcesOnly(s, hit);
    }
    flush();
  }
  return out.length > MAX_PER_PROMPT ? [] : out;
}

/** The first character in upper case; Turkish keeps its dotted i (i -> İ), which toUpperCase would lose. */
const upperFirst = (text: string, lang: string): string => {
  const c = text.charAt(0);
  return lang === "tr" && c === "i" ? "İ" : c.toUpperCase();
};

const markersFor = (lang: string): CompiledMarkers => compiledMarkers().find((m) => m.lang.code === lang) ?? compiledMarkers()[0]!;

/** The statement without its lead-in and marker: what it says, not that it is a decision. */
function statement(quote: string, lang: string): string {
  const m = markersFor(lang);
  let q = quote.trim();
  if (m.leadIn) {
    const lead = new RegExp(`^(?:${m.leadIn.source}[,:：]?\\s+)+`, "iu");
    q = q.replace(lead, "");
  }
  if (m.opener) {
    // "a team decision: …", "Team decision, from now on: …", "Change of decision on error types: …"
    const markerLead = new RegExp(`^(?:[\\p{L}']{1,4}\\s+){0,2}${m.opener.source}[^:：]{0,60}?[:：]\\s*`, "iu");
    q = q.replace(markerLead, "");
  }
  return q.trim();
}

/** The memory a statement becomes: its title from the statement itself, in its language; its first paragraph the quote. */
export function statedDecisionMemory(d: StatedDecision): { title: string; content: string } {
  const m = markersFor(d.lang);
  const head = statement(d.quote, d.lang);
  const first = splitSentences(head)[0] ?? head;
  let cut = first.length <= TITLE_CHARS ? first : first.slice(0, TITLE_CHARS).replace(/\s+\S*$/, "");
  // A cut inside a code span drops the span: a title is read, not parsed.
  if ((cut.match(/`/g) ?? []).length % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("`"));
  const prefix = d.kind === "changed-decision" ? m.lang.titles.changed : m.lang.titles.decision;
  const body = `${upperFirst(cut, d.lang)}${cut.slice(1)}`.replace(/[\s`#:;,.。、-]+$/, "");
  const when = d.at ? ` on ${d.at.slice(0, 10)}` : "";
  return { title: `${prefix}: ${body}`, content: `${d.quote}\n\nStated by the person in a session${when}; quoted as said.` };
}

const contentWords = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []);

/** True when an existing text already carries most of the statement's content words. */
export function saysTheSame(quote: string, existing: string, lang = "en"): boolean {
  const words = contentWords(statement(quote, lang));
  if (words.size < 4) return false;
  const have = contentWords(existing);
  let shared = 0;
  for (const w of words) if (have.has(w)) shared += 1;
  return shared / words.size >= SAME_STATEMENT_SHARE;
}

type DecisionStore = Pick<KnowledgeBackend, "listMemories" | "ensureNodeForPath" | "writeMemory"> & {
  recordGroundedAtom?: (workspaceId: string, atom: CapturedAtom) => Promise<unknown>;
};

/** The fact typed from a quote: the whole quote, or its leading sentences within one span. */
function factOf(quote: string): string {
  if (quote.length <= MAX_SPAN_CHARS) return quote;
  let fact = "";
  for (const s of splitSentences(quote)) {
    if (`${fact}${fact ? " " : ""}${s}`.length > MAX_SPAN_CHARS) break;
    fact = `${fact}${fact ? " " : ""}${s}`;
  }
  return fact || quote.slice(0, MAX_SPAN_CHARS);
}

/**
 * Read the prompts added to the ledger since the last pass and save each new statement at `/`, typed.
 * Returns how many were saved; the cursor moves either way.
 */
export interface LearnFromUserWordsOptions {
  /**
   * The model tier: asked about the typed prompts the marker table read nothing in, it returns the
   * statements it copied out of them (model-statements.ts). Absent for a workspace with no model.
   */
  onSilent?: (prompts: Array<{ text: string; sid: string | null; at: string | null }>) => Promise<StatedDecision[]>;
}

export async function learnFromUserWords(store: DecisionStore, workspaceId: string, cacheDir: string, now = new Date().toISOString(), options: LearnFromUserWordsOptions = {}): Promise<number> {
  const ledger = join(cacheDir, USER_WORDS_LEDGER);
  if (!existsSync(ledger)) return 0;
  const cursorFile = join(cacheDir, USER_WORDS_CURSOR);
  const size = statSync(ledger).size;
  let from = 0;
  let firstPass = false;
  try {
    from = Number(readFileSync(cursorFile, "utf8").trim()) || 0;
  } catch {
    firstPass = true;
  }
  if (from > size) from = 0;
  if (from === size) return 0;
  // The cursor is a byte offset (the file's size); the slice must be in bytes too. A character slice
  // skipped past the new lines whenever the prompts held non-ASCII text, which is every language but
  // English: measured on PathruleBench v3's Turkish, Japanese and German scenarios (2026-10-16), where
  // the drain read nothing in nine chains of nine.
  const fresh = new TextDecoder("utf8").decode(readFileSync(ledger).subarray(from));
  try {
    writeFileSync(cursorFile, String(size), { mode: 0o600 });
  } catch {
    // the next pass reads these prompts again; the dedupe below keeps the store the same
  }
  const found: StatedDecision[] = [];
  const silent: Array<{ text: string; sid: string | null; at: string | null }> = [];
  for (const line of fresh.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { sid?: string; at?: string; text?: string };
      if (firstPass && (!e.at || Date.parse(now) - Date.parse(e.at) > FIRST_PASS_WINDOW_MS)) continue;
      if (typeof e.text !== "string") continue;
      const here = statedDecisions(e.text, { sid: e.sid ?? null, at: e.at ?? null });
      if (here.length > 0) found.push(...here);
      else if (options.onSilent && typedPrompt(e.text)) silent.push({ text: e.text.trim(), sid: e.sid ?? null, at: e.at ?? null });
    } catch {
      // a torn line
    }
  }
  if (options.onSilent && silent.length > 0) {
    try {
      found.push(...(await options.onSilent(silent)));
    } catch {
      // the model tier is an addition; a failure there loses nothing the table found
    }
  }
  if (found.length === 0) return 0;
  const existing = (await store.listMemories({ workspaceId })).map((m) => `${m.title}\n${m.content}`);
  const root = await store.ensureNodeForPath(workspaceId, "/", "folder");
  let saved = 0;
  for (const d of found) {
    if (existing.some((text) => saysTheSame(d.quote, text, d.lang))) continue;
    const { title, content } = statedDecisionMemory(d);
    const m = await store.writeMemory({ workspaceId, nodeId: root.id, title, content, source: "claude" });
    existing.push(`${title}\n${content}`);
    saved += 1;
    if (store.recordGroundedAtom) {
      const c = captureGroundedAtom({ kind: "context", fact: [factOf(d.quote)] }, { kind: "memory", id: m.id, title, content }, now);
      if (c.ok) await store.recordGroundedAtom(workspaceId, c.atom);
    }
  }
  return saved;
}
