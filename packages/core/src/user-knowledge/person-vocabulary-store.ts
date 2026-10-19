// SPDX-License-Identifier: Apache-2.0
/**
 * Where a person's word counts live: one small file per user key, next to their beliefs, written 0600.
 *
 * Holds hashed word keys and counts only (see `person-vocabulary.ts`), never a word or a message. Bounded:
 * once it holds more keys than `MAX_KEYS`, the rarest are dropped, which are exactly the ones that could
 * never become a stop word anyway. A missing or corrupt file means "nothing learned yet", never an error:
 * relevance then falls back to needing two independent hits.
 */
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { PATHRULE_FILE_MODE, hashUserIdForPath, pathruleHome } from "../storage/paths.js";
import { messageWords, wordKey, type VocabularyCounts } from "./person-vocabulary.js";

const MAX_KEYS = 20_000;

interface VocabularyFile extends VocabularyCounts {
  schema_version: 1;
  updated_at: string;
}

export function personVocabularyPath(userKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "user-intelligence", `${hashUserIdForPath(userKey)}.vocab.json`);
}

export async function readPersonVocabulary(userKey: string, env: NodeJS.ProcessEnv = process.env): Promise<VocabularyCounts | null> {
  try {
    const raw = JSON.parse(await readFile(personVocabularyPath(userKey, env), "utf8")) as Partial<VocabularyFile>;
    if (raw?.schema_version !== 1 || typeof raw.messages !== "number" || !raw.df || typeof raw.df !== "object") return null;
    return { messages: raw.messages, df: raw.df };
  } catch {
    return null;
  }
}

/** One read-modify-write at a time per file inside this process. */
const queues = new Map<string, Promise<unknown>>();

/** Count messages the person typed. Best-effort: a failed write costs a count, never a turn. */
export async function recordPersonVocabulary(
  userKey: string,
  messages: readonly string[],
  opts: { now: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const env = opts.env ?? process.env;
  const texts = messages.filter((m) => m.trim().length > 0);
  if (texts.length === 0) return;
  const path = personVocabularyPath(userKey, env);
  const run = async () => {
    const current = (await readPersonVocabulary(userKey, env)) ?? { messages: 0, df: {} };
    const df: Record<string, number> = { ...current.df };
    for (const text of texts) for (const w of messageWords(text)) df[wordKey(w)] = (df[wordKey(w)] ?? 0) + 1;
    let entries = Object.entries(df);
    if (entries.length > MAX_KEYS) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS);
    const file: VocabularyFile = { schema_version: 1, messages: current.messages + texts.length, df: Object.fromEntries(entries), updated_at: opts.now };
    await atomicWrite(path, JSON.stringify(file));
    try { await chmod(path, PATHRULE_FILE_MODE); } catch { /* best effort, like the belief store */ }
  };
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(run, run);
  queues.set(path, next.catch(() => {}));
  await next.catch(() => {});
}
