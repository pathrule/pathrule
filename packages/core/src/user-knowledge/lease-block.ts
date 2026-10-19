// SPDX-License-Identifier: Apache-2.0
/**
 * The ```pathrule-lease block an agent ends its answer with after checking a library's docs (see
 * `expertise-lease.ts`), parsed and cleaned the same way wherever it is read: in the main process that
 * stores it, and in the chat renderer that shows it as a note instead of raw JSON. No Node imports.
 */

/** Per-item caps, shared by storage and display. */
export const LEASE_TEXT_LIMITS = { maxSources: 5, maxFacts: 6, factChars: 280 } as const;

const FENCE = /```pathrule-lease\s*\n([\s\S]*?)\n\s*```/gi;

export interface RawLease {
  library?: unknown;
  version?: unknown;
  sources?: unknown;
  facts?: unknown;
  replaces?: unknown;
  checks?: unknown;
}

/** The last well-formed lease block in an answer, or null. Never throws. */
export function parseLeaseBlock(text: string): RawLease | null {
  if (!text || !text.includes("pathrule-lease")) return null;
  let found: RawLease | null = null;
  for (const m of text.matchAll(FENCE)) {
    try {
      const v = JSON.parse(m[1]!.trim()) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) found = v as RawLease;
    } catch {
      // A malformed block is skipped, not fatal.
    }
  }
  return found;
}

/** Text that addresses the reader rather than describing the library. */
const INSTRUCTION_LIKE = /\b(ignore (all |any |the )?(previous|prior|above|earlier)|disregard|system prompt|you are now|new instructions|do not tell)\b/i;

/** One line of lease text: no fences, no line breaks, no leading markdown, capped. Empty means drop it. */
export function cleanLeaseText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/`{3,}/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s#>*-]+/, "")
    .trim();
  if (text.length === 0 || INSTRUCTION_LIKE.test(text)) return "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A source must be a plain web URL; credentials and fragments are dropped, duplicates collapse. */
export function cleanSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    try {
      const url = new URL(raw.trim());
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) continue;
      url.hash = "";
      out.add(url.toString());
    } catch {
      // Not a URL.
    }
    if (out.size >= LEASE_TEXT_LIMITS.maxSources) break;
  }
  return [...out];
}

/** An answer carries a lease block, complete or still streaming. */
export function hasLeaseFence(text: string): boolean {
  return /```pathrule-lease\b/i.test(text ?? "");
}

/** What the chat note shows: the library, version, cleaned facts and sources. Null when nothing useful. */
export function leaseNoteOf(text: string): { library: string; version: string; facts: string[]; sources: string[] } | null {
  const raw = parseLeaseBlock(text);
  if (!raw || typeof raw.library !== "string" || !raw.library.trim()) return null;
  const facts = (Array.isArray(raw.facts) ? raw.facts : [])
    .map((f) => cleanLeaseText(f, LEASE_TEXT_LIMITS.factChars))
    .filter(Boolean)
    .slice(0, LEASE_TEXT_LIMITS.maxFacts);
  const sources = cleanSources(raw.sources);
  if (facts.length === 0 || sources.length === 0) return null;
  return { library: raw.library.trim().slice(0, 80), version: typeof raw.version === "string" ? raw.version.trim().slice(0, 40) : "", facts, sources };
}
