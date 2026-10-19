// SPDX-License-Identifier: Apache-2.0
/**
 * The open half of the model tier of the stated-decision capture: what a client sends (`StatementPrompt`),
 * what it gets back (`StatementExtraction`), and the grounding every returned quote passes. A model may
 * only COPY a lasting sentence: a quote that is not in the prompt, whitespace aside, is dropped, so what
 * is saved is still the person's sentence and this path and the marker table's produce the same memory.
 * The model call itself, its instruction and its schema run in the Cloud Worker.
 */
import type { StatedDecision } from "./stated-decisions.js";

const MAX_QUOTE_CHARS = 700;

const squeeze = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The quote as it stands in the prompt, or null when the model did not copy. */
export function groundQuote(prompt: string, quote: string): string | null {
  const q = squeeze(quote);
  if (q.length < 8 || q.length > MAX_QUOTE_CHARS) return null;
  if (prompt.includes(q)) return q;
  // The model may have normalised whitespace; find the span in the original by its squeezed form.
  const flat = squeeze(prompt);
  if (!flat.includes(q)) return null;
  return q;
}

/** Parse the model's JSON, tolerating text around it. */
export function parseStatements(text: string): Array<{ quote: string; kind: string; lang: string; beyond: boolean }> {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { statements?: unknown })?.statements;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is { quote: string; kind: string; lang: string; beyond_this_task?: string } => !!s && typeof s === "object" && typeof (s as { quote?: unknown }).quote === "string")
    .map((s) => ({
      quote: s.quote,
      kind: typeof s.kind === "string" ? s.kind : "decision",
      lang: typeof s.lang === "string" ? s.lang.toLowerCase().slice(0, 2) : "en",
      // The model's own test: a statement that only directs the work at hand is not kept. Absent means kept.
      beyond: s.beyond_this_task !== "no",
    }));
}

/** A typed prompt the marker table read nothing in, as the client sends it to a model tier. */
export interface StatementPrompt {
  text: string;
  sid?: string | null;
  at?: string | null;
}

/** What a model tier returns: the statements it copied, and how the calls went. Nothing is saved by it. */
export interface StatementExtraction {
  asked: number;
  dropped: number;
  failed: number;
  statements: StatedDecision[];
}
