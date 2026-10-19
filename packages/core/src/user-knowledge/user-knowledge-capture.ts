// SPDX-License-Identifier: Apache-2.0
/**
 * Knowing the person without an engine: capture a working preference from the person's OWN words,
 * and compile what has been learned for the hook index.
 *
 * The agent in the session understood the person; it names the preference and quotes them. This
 * module never judges meaning, so it reads every language the same way, and it keeps every invariant
 * of the user layer (`user-knowledge.ts`):
 *
 *  - GROUNDED: each quote must be byte-present in something the person actually typed in this
 *    workspace recently (the hook's private `user-words.jsonl`), never in what the agent wrote.
 *  - NOT GLOBALIZED ON ONE EVENT: something said to an agent in the middle of work is INFERRED. It
 *    starts as a candidate no agent sees, and becomes active when the person says it again in a
 *    second, separate session (thread), or at once when they stated it as a lasting way of working
 *    (`stated_lasting`). It travels to other workspaces only once a second workspace shows it
 *    (`effectiveUserWorkspace`).
 *  - ADVISORY: only SELECTION, PROCEDURE and CONTEXT; never enforced; workspace rules outrank it.
 *  - PRIVATE: stored in the person's own local file, never in workspace knowledge.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userKnowledgeFingerprint } from "./user-knowledge-lifecycle.js";
import { USER_PRIMITIVES, type UserEvidence, type UserKnowledgeAtom, type UserPrimitive } from "./user-knowledge.js";
import { listAllUserKnowledge, type UserKnowledgeStore } from "./user-knowledge-persistence.js";
import { compileUserPreferenceEntries, learnPersonVocabulary, type UserPreferenceEntry } from "./user-delivery.js";

/** The hook's private record of what the person typed, per workspace, for grounding only. */
export const USER_WORDS_LEDGER = "user-words.jsonl";
/** How far back a quote may come from. */
export const USER_WORDS_WINDOW = 200;
export const MAX_CLAIM_CHARS = 280;

export interface UserWords {
  sid: string | null;
  at: string;
  text: string;
}

export function readUserWords(cacheDir: string): UserWords[] {
  const file = join(cacheDir, USER_WORDS_LEDGER);
  if (!existsSync(file)) return [];
  const out: UserWords[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).slice(-USER_WORDS_WINDOW)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<UserWords>;
      if (typeof r.text === "string" && r.text.length > 0) out.push({ sid: typeof r.sid === "string" ? r.sid : null, at: typeof r.at === "string" ? r.at : "", text: r.text });
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Keep the private ledger bounded: only the window grounding reads is ever needed. */
export function trimUserWords(cacheDir: string): void {
  const file = join(cacheDir, USER_WORDS_LEDGER);
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > USER_WORDS_WINDOW * 2) writeFileSync(file, lines.slice(-USER_WORDS_WINDOW).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // nothing to trim
  }
}

export interface PreferenceClaim {
  kind: UserPrimitive;
  /** The agent-facing sentence. Composed wording; never treated as evidence. */
  claim: string;
  /** Verbatim spans of the person's own words carrying the claim. */
  quotes: string[];
  /** Verbatim spans naming WHEN it applies. Empty: always. */
  when?: string[];
  /** Id of a stored belief this is the same preference as, said again. */
  same_as?: string;
  /** The person said it holds for all their work. Ignored when `when` names a condition. */
  always?: boolean;
  /** The person stated it as a lasting way of working, not a remark about this task. */
  lasting?: boolean;
}

export type PreferenceCaptureResult =
  | { ok: true; id: string; status: UserKnowledgeAtom["status"]; sessions: number; candidates: Array<{ id: string; claim: string }> }
  | { ok: false; code: "preference_kind_unknown" | "preference_no_claim" | "preference_claim_too_long" | "preference_no_quote" | "preference_not_their_words" | "preference_unknown_same_as"; message: string };

const fail = (code: Extract<PreferenceCaptureResult, { ok: false }>["code"], message: string): PreferenceCaptureResult => ({ ok: false, code, message });

/** Distinct sessions (threads) the evidence comes from: the unit of "said again". */
function sessionsOf(evidence: readonly UserEvidence[]): number {
  return new Set(evidence.map((e) => e.thread_id ?? e.message_id ?? e.observed_at)).size;
}

function judged(atom: UserKnowledgeAtom): UserKnowledgeAtom {
  if (atom.status === "rejected" || atom.status === "retired") return atom;
  const n = sessionsOf(atom.evidence);
  // Stated as lasting, the person's own words weigh as a repeat in a second session does.
  const lasting = atom.stated_lasting === true;
  return { ...atom, confidence: n >= 3 ? "high" : n >= 2 || lasting ? "medium" : "low", status: n >= 2 || lasting ? "active" : "candidate" };
}

/** Capture one preference, or add evidence to the belief it repeats. Pure except for the store. */
export async function captureUserPreference(
  store: UserKnowledgeStore,
  claim: PreferenceClaim,
  ctx: { workspaceId: string; words: readonly UserWords[]; now: string },
): Promise<PreferenceCaptureResult> {
  if (!USER_PRIMITIVES.includes(claim.kind)) return fail("preference_kind_unknown", "kind must be selection, procedure or context.");
  const sentence = (claim.claim ?? "").trim();
  if (!sentence) return fail("preference_no_claim", "Say the preference in one sentence.");
  if (sentence.length > MAX_CLAIM_CHARS) return fail("preference_claim_too_long", `Keep the preference under ${MAX_CLAIM_CHARS} characters.`);
  const quotes = (claim.quotes ?? []).map((q) => q.trim()).filter(Boolean);
  if (quotes.length === 0) return fail("preference_no_quote", "Quote the person's own words.");
  const when = (claim.when ?? []).map((q) => q.trim()).filter(Boolean);
  // The most recent message that holds every quote and trigger: that is where the person said it.
  const said = [...ctx.words].reverse().find((w) => [...quotes, ...when].every((q) => w.text.includes(q)));
  if (!said) return fail("preference_not_their_words", "Every quote must be copied verbatim from one message the person typed in this workspace.");
  const evidence: UserEvidence = {
    kind: "decision",
    quote: said.text.slice(0, 1000),
    observed_at: said.at || ctx.now,
    surface: "cli",
    workspace_id: ctx.workspaceId,
    thread_id: said.sid,
    message_id: createHash("sha256").update(said.text).digest("hex").slice(0, 32),
    taught: false,
  };
  const records = await listAllUserKnowledge(store);
  const all = records.map((r) => r.atom);
  const fingerprint = userKnowledgeFingerprint({ primitive: claim.kind, claim: sentence });
  const record = claim.same_as ? records.find((r) => r.atom.id === claim.same_as) : records.find((r) => r.atom.fingerprint === fingerprint);
  if (claim.same_as && !record) return fail("preference_unknown_same_as", `No stored preference has id ${claim.same_as}.`);
  const operationId = (id: string) => createHash("sha256").update(`${id}:${evidence.message_id}`).digest("hex");
  let atom: UserKnowledgeAtom;
  if (record) {
    const existing = record.atom;
    const known = existing.evidence.some((e) => e.message_id === evidence.message_id);
    atom = judged({ ...existing, ...(claim.always && when.length === 0 ? { applies_always: true, trigger_evidence: [] } : {}), ...(claim.lasting ? { stated_lasting: true } : {}), evidence: known ? existing.evidence : [...existing.evidence, evidence], updated_at: ctx.now, last_observed_at: evidence.observed_at > existing.last_observed_at ? evidence.observed_at : existing.last_observed_at });
    await store.put(atom, { expectedVersion: record.version, operationId: operationId(atom.id), now: ctx.now });
  } else {
    atom = judged({
      id: fingerprint, kind: "user_knowledge", primitive: claim.kind, scope: "user", claim: sentence,
      claim_evidence: quotes, trigger_evidence: when, source_type: "INFERRED", evidence: [evidence],
      confidence: "low", status: "candidate", applies_to_workspace_id: null, applies_to_path: null,
      created_at: ctx.now, updated_at: ctx.now, last_observed_at: evidence.observed_at, superseded_by: null, fingerprint,
      ...(claim.always && when.length === 0 ? { applies_always: true } : {}),
      ...(claim.lasting ? { stated_lasting: true } : {}),
    });
    await store.put(atom, { expectedVersion: null, operationId: operationId(atom.id), now: ctx.now });
  }
  const candidates = all.filter((a) => a.id !== atom.id && a.status === "candidate").slice(0, 5).map((a) => ({ id: a.id, claim: a.claim }));
  return { ok: true, id: atom.id, status: atom.status, sessions: sessionsOf(atom.evidence), candidates };
}

/**
 * Did the person type this quote again? A long run of the same words (at least 60% of the quote, and
 * at least 20 characters), compared without case. Structural, so it reads every language the same way,
 * and strict enough that a paraphrase does not count: only the person's own words repeated do.
 */
export function repeatsQuote(quote: string, text: string): boolean {
  const q = quote.trim().toLowerCase().slice(0, 400), t = text.toLowerCase().slice(0, 4000);
  if (q.length < 20) return false;
  // Longest common substring, exactly: a sampled scan missed a repeat by one character when the agent's
  // quote carried a few extra words around the person's phrase.
  let best = 0;
  let prev = new Uint16Array(t.length + 1);
  for (let i = 1; i <= q.length; i += 1) {
    const row = new Uint16Array(t.length + 1);
    for (let j = 1; j <= t.length; j += 1) if (q[i - 1] === t[j - 1]) { row[j] = prev[j - 1]! + 1; if (row[j]! > best) best = row[j]!; }
    prev = row;
  }
  return best >= Math.max(20, Math.ceil(q.length * 0.6));
}

/**
 * A candidate the person states again in another session becomes active without waiting for an agent
 * to notice: their own words, in a new session, are the evidence the user layer asks for. Returns the
 * ids promoted. Never adds a session the belief already has, never revives a rejected or retired one.
 */
export async function promoteRepeatedPreferences(store: UserKnowledgeStore, words: readonly UserWords[], workspaceId: string, now: string): Promise<string[]> {
  const promoted: string[] = [];
  for (const record of await listAllUserKnowledge(store)) {
    const atom = record.atom;
    if (atom.status !== "candidate" || (atom.basis ?? "words") !== "words") continue;
    const sessions = new Set(atom.evidence.map((e) => e.thread_id));
    const again = words.find((w) => !sessions.has(w.sid) && atom.claim_evidence.some((q) => repeatsQuote(q, w.text)));
    if (!again) continue;
    const evidence: UserEvidence = {
      kind: "decision", quote: again.text.slice(0, 1000), observed_at: again.at || now, surface: "cli", workspace_id: workspaceId,
      thread_id: again.sid, message_id: createHash("sha256").update(again.text).digest("hex").slice(0, 32), taught: false,
    };
    const next = judged({ ...atom, evidence: [...atom.evidence, evidence], updated_at: now, last_observed_at: evidence.observed_at > atom.last_observed_at ? evidence.observed_at : atom.last_observed_at });
    const write = await store.put(next, { expectedVersion: record.version, operationId: createHash("sha256").update(`${atom.id}:${evidence.message_id}`).digest("hex"), now });
    if (write.status === "written" && next.status === "active") promoted.push(atom.id);
  }
  return promoted;
}

/**
 * The person's entries for the hook index when no engine compiles them: repeats promoted from the
 * hook's ledger of their words, then the open compiler over the stored beliefs. Every writer of the
 * index passes these, or the index it writes carries no preferences until the next MCP write
 * (measured on PathruleBench v3, 2026-10-16: `pathrule sync --local` dropped a stated habit).
 */
export async function openPersonalIndexEntries(store: UserKnowledgeStore, cacheDir: string, workspaceId: string, aliases: readonly (string | null)[], now = new Date().toISOString()) {
  await promoteRepeatedPreferences(store, readUserWords(cacheDir), workspaceId, now).catch(() => []);
  return { userPreferences: await openUserPreferenceEntries(store, workspaceId, aliases), guidance: [] as never[], personalOwner: null as string | null };
}

/** What the hook index carries about the person when no engine compiles it: the open compiler over the stored beliefs. */
export async function openUserPreferenceEntries(store: UserKnowledgeStore, workspaceId: string, aliases: readonly (string | null)[]): Promise<UserPreferenceEntry[]> {
  try {
    const atoms = (await listAllUserKnowledge(store)).map((r) => r.atom);
    // The index is written before any working path is known: a belief narrowed to a path travels marked with
    // it, and the hook delivers it only there (0bdbc9962).
    return compileUserPreferenceEntries(atoms, { workspace_id: workspaceId, path: null, workspace_aliases: aliases }, learnPersonVocabulary(atoms), { carryPathScope: true });
  } catch {
    return [];
  }
}
