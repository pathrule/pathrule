// SPDX-License-Identifier: Apache-2.0
/**
 * Which of a person's words carry no topic, learned from how they write rather than listed per language.
 *
 * Relevance needs to know that "the", "ve", "und" or "の" say nothing about which preference a prompt is
 * about. A list can only know that for the languages it lists, which held people writing in those
 * languages to a different rule than everyone else. So it is learned: a word that appears in a large share
 * of everything the person wrote is a function word of their language, or a name they use everywhere
 * ("pathrule" in its own repository), and either way it carries no topic. Measured on a real store of 39
 * messages: the words that cleared the bar were exactly the function words ("bu", "ve", "bir", "gibi",
 * "için") plus the names in every message ("pathrule", "claude"), with no list in any language.
 *
 * Counted from every message the person types (`person-vocabulary-store.ts`), model-free, so it works with
 * no local LLM. Words are kept only as HASHES of their folded form with a count: the store says how often a
 * word was used without ever holding the word. A script that does not separate words (CJK) simply learns
 * little and loses nothing.
 *
 * Browser-safe: pure functions only.
 */
import { foldText, foldedWords } from "./text-fold.js";

export interface PersonVocabulary {
  /** True for a folded word that carries no topic for this person. */
  isStop(word: string): boolean;
  /** Enough of their writing was seen to know. Until then a condition needs two independent hits. */
  learned: boolean;
}

export const NO_VOCABULARY: PersonVocabulary = { isStop: () => false, learned: false };

/** Distinct messages needed before a word's share means anything. */
export const VOCABULARY_MIN_MESSAGES = 8;
/** A word in at least this share of the person's messages (and in three or more) carries no topic. */
export const VOCABULARY_STOP_SHARE = 0.15;

/** A message reduced to what is counted: its distinct folded words of three letters or more. */
export function messageWords(text: string): string[] {
  return [...new Set(foldedWords(text).filter((w) => w.length >= 3))];
}

/** FNV-1a over the folded word, base 36. Stable across processes and surfaces; not reversible. */
export function wordKey(word: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** What the store holds: how many messages were counted, and in how many of them each word key appeared. */
export interface VocabularyCounts {
  messages: number;
  df: Readonly<Record<string, number>>;
}

function stopBar(messages: number): number {
  return Math.max(3, Math.ceil(VOCABULARY_STOP_SHARE * messages));
}

/** The vocabulary a set of counts supports. Below the minimum it knows nothing yet. */
export function vocabularyFromCounts(counts: VocabularyCounts | null | undefined): PersonVocabulary {
  if (!counts || counts.messages < VOCABULARY_MIN_MESSAGES) return NO_VOCABULARY;
  const bar = stopBar(counts.messages);
  return { isStop: (word) => (counts.df[wordKey(word)] ?? 0) >= bar, learned: true };
}

/** Count a set of messages in memory (identical messages once), for callers that hold the text. */
export function countMessages(messages: Iterable<string>): VocabularyCounts {
  const seen = new Set<string>();
  const df: Record<string, number> = {};
  for (const m of messages) {
    const norm = foldText(m).replace(/\s+/g, " ").trim();
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    for (const w of messageWords(norm)) df[wordKey(w)] = (df[wordKey(w)] ?? 0) + 1;
  }
  return { messages: seen.size, df };
}

export function vocabularyFromMessages(messages: Iterable<string>): PersonVocabulary {
  return vocabularyFromCounts(countMessages(messages));
}
