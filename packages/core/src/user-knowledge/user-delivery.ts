// SPDX-License-Identifier: Apache-2.0
/**
 * Compiling USER knowledge into what an agent actually receives, alongside workspace knowledge.
 *
 * Two jobs, and the second one is a safety property rather than a feature.
 *
 * RELEVANCE. A person's preferences are not a preamble to staple onto every prompt. "Fix a typo in the
 * README" must not carry "prefer incremental migrations"; the tokens are wasted and the noise teaches
 * an agent to skim. So a belief that named WHEN it applies is delivered only when the work matches
 * that condition, and a belief that named no condition (how someone wants to be talked to) travels
 * everywhere because it always applies.
 *
 * AUTHORITY. User knowledge shapes collaboration; it never licenses breaking the project. The
 * invariant here is structural rather than judged: this module CANNOT remove, reorder below, or weaken
 * a workspace requirement, because it never receives the power to. It takes the requirement lines as
 * given, emits them first, and appends preferences after them under a heading that says what they are.
 * A preference cannot be read as permission because it is never rendered as one, and the deterministic
 * CHECK/CONSTRAINT pipeline it would have to override is untouched by anything in this file.
 *
 * That is deliberately less clever than "detect the conflict and resolve it". Conflict detection by
 * term overlap fails exactly where it matters ("prefer targeted tests" shares no words with "run the
 * full migration verification suite"), and a confident wrong resolution is worse than none.
 */
import { foldText, foldedWords } from "./text-fold.js";
import { NO_VOCABULARY, vocabularyFromMessages, type PersonVocabulary } from "./person-vocabulary.js";
import { agentFacingClaim } from "./claim-referent.js";
import { isUserKnowledgeDeliverable, userKnowledgeApplies, type UserKnowledgeAtom, type UserKnowledgeWhere } from "./user-knowledge.js";

export { foldText, foldedWords, NO_VOCABULARY, type PersonVocabulary };

/** A binding workspace item, already rendered by the workspace pipeline. Passed through untouched. */
export interface WorkspaceRequirementLine {
  kind: "constraint" | "check";
  line: string;
}

export interface UserDeliveryInput {
  atoms: readonly UserKnowledgeAtom[];
  /** Where the work is happening, for scope narrowing. */
  where: UserKnowledgeWhere;
  /** What the agent is about to do. Free text: a task title, a prompt, a description. */
  taskText: string;
  /** Workspace requirements for this task. Emitted first and never altered. */
  requirements?: readonly WorkspaceRequirementLine[];
  /** Hard cap on how many preferences may be delivered. Relevance first, then the cap. */
  maxItems?: number;
  /** Which of the person's words carry no topic. Learned from their beliefs' words when absent. */
  vocabulary?: PersonVocabulary;
}

export type UserSuppressionReason = "not_deliverable" | "out_of_scope" | "not_relevant" | "risk_gate" | "over_budget";

export interface UserDeliveryResult {
  /** The preferences that will be shown, in delivery order. */
  delivered: UserKnowledgeAtom[];
  /** Everything held back, with the reason, so the decision is inspectable rather than mysterious. */
  suppressed: Array<{ atom: UserKnowledgeAtom; reason: UserSuppressionReason }>;
  /** The full agent-facing block, requirements first. Empty string when there is nothing to say. */
  text: string;
}

const DEFAULT_MAX_ITEMS = 5;

/**
 * The words of Pathrule's OWN claim sentences that carry no topic. Every claim is written in English for
 * every person (the extraction contract asks for it), so this list describes Pathrule's sentence shape,
 * not anyone's language, and it is applied to CLAIM text only. The person's own words (trigger spans) are
 * never filtered by a list in one language; their function words are learned from how they write
 * (`learnPersonVocabulary`), the same way for every language.
 *
 * Measured, which is why it is longer than it once was: with "every" missing, the claim-side trigger
 * "Every night" delivered a nightly-routine procedure onto an unrelated research prompt that happened to
 * say "every skill". Quantifiers, fillers and the words that only say "doing software work" are
 * topic-free in the same way. Entries are stored FOLDED (see `foldText`).
 */
const CLAIM_GRAMMAR: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "for", "to", "of", "in", "on", "at", "by",
  "with", "from", "into", "over", "under", "is", "are", "was", "were", "be", "been", "being", "do", "does",
  "did", "done", "this", "that", "these", "those", "it", "its", "as", "when", "while", "before", "after",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them", "prefer", "prefers", "preferred",
  "want", "wants", "like", "likes", "should", "would", "could", "can", "will", "just", "only", "very", "more",
  "most", "less", "not", "no", "yes", "please", "always", "never", "work", "working", "use", "using", "used",
  // Quantifiers and fillers: they say how much, never what about.
  "every", "each", "all", "any", "some", "many", "much", "few", "other", "another", "same", "such", "own",
  "also", "too", "again", "still", "even", "really", "sure", "okay", "let", "lets", "get", "got", "make",
  "made", "need", "needs", "new", "now", "here", "there", "what", "which", "who", "how", "why", "where",
  "about", "via", "per", "out", "off", "one", "two", "way", "ways", "time", "times", "thing", "things",
  "stuff", "etc", "thanks", "thank", "good", "great", "nice", "well", "able", "tends", "usually", "often",
  // Words that only say "doing software work", mirrored from the conflict gate's GENERIC_WORK.
  "change", "changes", "code", "task", "tasks", "implementation", "implement", "update", "updates",
  "project", "version", "part", "parts", "user", "agent", "person",
]);

/**
 * The person's vocabulary when no counts were handed in: learned from the words already on file in their
 * beliefs. The service passes the counts from every message they typed instead (`readPersonVocabulary`).
 */
export function learnPersonVocabulary(atoms: readonly UserKnowledgeAtom[]): PersonVocabulary {
  const messages: string[] = [];
  for (const atom of atoms) {
    // Behavioural evidence is Pathrule's own description of an episode, not the person's words.
    if ((atom.basis ?? "words") !== "words") continue;
    for (const e of atom.evidence) messages.push(e.quote);
  }
  return vocabularyFromMessages(messages);
}

const isClaimGrammar = (word: string): boolean => CLAIM_GRAMMAR.has(word);

/**
 * Reduce a word to a crude stem so "architectural" and "architecture" match.
 *
 * Deliberately not a real stemmer. This decides whether to spend a few tokens, and a wrong call in
 * either direction is cheap: a missed preference is one the person can restate, an extra one is noise.
 * A linguistics dependency would be a worse trade than the occasional miss. English, because it is only
 * applied to Pathrule's own claim sentences, which are English for everyone; the person's own words are
 * never stemmed by one language's rules, and meet the prompt through `termMatchesWord` alone.
 */
export function stem(word: string): string {
  let w = foldText(word).replace(/[^\p{L}\p{N}]+/gu, "");
  const suffixes = ["ically", "ational", "ation", "ical", "ing", "edly", "ally", "ies", "ed", "al", "es", "s"];
  // Two passes, because plurals stack on nominalisations: "migrations" has to lose "s" before "ation"
  // is even visible, and stopping after one pass would leave it unequal to "migration".
  for (let pass = 0; pass < 2; pass += 1) {
    for (const suffix of suffixes) {
      if (w.length > suffix.length + 3 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
    }
  }
  // A trailing "e" is the last difference between "architecture" and "architectural" once "al" is gone.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/**
 * The topic terms of a text. The defaults are right for a CLAIM (Pathrule's English sentence): its
 * grammar words dropped, English stems. A span of the person's own words is filtered by their learned
 * vocabulary and left unstemmed instead (`beliefTerms`).
 */
export function topicTerms(text: string, isStop: (word: string) => boolean = isClaimGrammar, stemmed = true): Set<string> {
  const out = new Set<string>();
  for (const bare of foldedWords(text)) {
    if (bare.length < 3 || isStop(bare)) continue;
    out.add(stemmed ? stem(bare) : bare);
  }
  return out;
}

/**
 * The prompt side of matching: folded words, unstemmed. Stop words are removed from TERMS, not from the
 * prompt, which is what lets the standalone hook apply the identical rule without carrying the list.
 */
export function promptWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of foldedWords(text)) if (w.length >= 3) out.add(w);
  return out;
}

/**
 * Does one stemmed term hit one prompt word?
 *
 * Exact, or the word starts with the stem ("architectur" / "architectural"), or the stem starts with a
 * word of five letters or more. The last direction is for every language that inflects by appending
 * (Turkish, Finnish, Hungarian, Korean, Japanese in romaji): the term "migrasyonlar" must still meet the
 * prompt word "migrasyon". Five letters keeps "test" from meeting "testimony" through the back door.
 * `pathrule-hook.js` applies the same rule.
 */
export function termMatchesWord(term: string, word: string): boolean {
  if (word === term) return true;
  if (term.length >= 4 && word.startsWith(term)) return true;
  if (word.length >= 5 && term.startsWith(word)) return true;
  return sharesRoot(term, word);
}

/**
 * Two inflections of one root: a common prefix of six letters or more that is most (80%) of the shorter
 * word ("architectural" and "architecture", "migrasyonlar" and "migrasyonu", "Konfiguration" and
 * "konfigurieren"). Language-neutral, which is why it exists: the person's own words are never stemmed
 * by one language's rules, so this is how their inflections meet. Six letters and 80% keep "testing"
 * from meeting "testimony" and "community" from meeting "communication".
 */
export function sharesRoot(a: string, b: string): boolean {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n >= 6 && n >= Math.ceil(0.8 * Math.min(a.length, b.length));
}

/** How many distinct terms the prompt hits. */
export function countTermHits(terms: Iterable<string>, words: ReadonlySet<string>): number {
  let hits = 0;
  for (const term of terms) {
    for (const word of words) {
      if (termMatchesWord(term, word)) { hits += 1; break; }
    }
  }
  return hits;
}

/**
 * How many terms must hit before a belief counts as relevant.
 *
 * A short trigger or claim ("for architectural work", "prefers targeted tests over running everything")
 * names its topic with every content word, so one distinctive hit is relevance. A long composed claim
 * ("a nightly routine that scans for changes, regenerates the registry, opens a PR ...") is full of words
 * that merely happen to be there, and one shared word is how an unrelated procedure rode along on a
 * research prompt. From five content terms (four for a trigger, which is already the condition itself)
 * two independent hits are required.
 */
export function minTermHits(termCount: number, fromTrigger: boolean, learned = true): number {
  // Before the person's vocabulary is known, one shared word in their own phrasing may be a function word
  // of their language, so a condition of two or more terms needs two independent hits. Every language
  // starts the same way.
  if (fromTrigger && !learned && termCount >= 2) return 2;
  return termCount >= (fromTrigger ? 4 : 5) ? 2 : 1;
}

/**
 * The terms that make a belief relevant: its condition in the person's own words when it named one
 * (filtered by what carries no topic for them), else its claim (filtered by Pathrule's claim grammar too).
 */
export function beliefTerms(atom: UserKnowledgeAtom, vocab: PersonVocabulary): { terms: Set<string>; fromTrigger: boolean } {
  const triggers = atom.trigger_evidence.filter((t) => t.trim().length > 0);
  const fromTrigger = triggers.length > 0;
  return {
    terms: fromTrigger
      ? topicTerms(triggers.join(" "), (w) => vocab.isStop(w), false)
      : topicTerms(atom.claim, (w) => isClaimGrammar(w) || vocab.isStop(w)),
    fromTrigger,
  };
}

/** A belief with no condition that applies to any task: how to work WITH the person, or how they write. */
export function appliesUnconditionally(atom: UserKnowledgeAtom): boolean {
  // A habit the person stated as lasting is in force for this session's work whatever the prompt says,
  // as it would be from a CLAUDE.md: "add tests for it" shares one word with "a comment line above every
  // new test function", which no topic gate passes. Once per session, so a habit costs one line. A
  // trigger does not gate it either: one saved as "every test function" kept the habit from every later
  // session, and the rendered line still carries the condition.
  if (atom.stated_lasting === true) return true;
  const triggers = atom.trigger_evidence.filter((t) => t.trim().length > 0);
  if (triggers.length > 0) return false;
  if (atom.applies_always === true) return true;
  // CONTEXT is about the collaboration itself. A belief learned from edits or choices is about how the
  // person wants code written, which is true of every turn that writes code, not of one topic.
  return atom.primitive === "context" || atom.basis === "edits" || atom.basis === "choices";
}

/**
 * Does this belief apply to the work described?
 *
 * A belief with no stated condition is general (how someone wants to be communicated with applies to a
 * typo fix as much as to a migration), so it is always relevant. A belief that named a condition has to
 * match it, which is what keeps architecture preferences away from README typos.
 */
export function isRelevantToTask(atom: UserKnowledgeAtom, taskText: string, vocab: PersonVocabulary = NO_VOCABULARY): boolean {
  if (appliesUnconditionally(atom)) return true;
  const words = promptWords(taskText);
  if (words.size === 0) return false;

  // A SELECTION or PROCEDURE with no separate condition is still about a kind of work, and the
  // extractor routinely folds the condition into the sentence ("prefers incremental migrations for
  // database work") instead of quoting it separately. Measured: relying on the trigger field alone let
  // exactly that shape ride along on "Fix typo in README". So the claim's own topic has to match.
  const { terms, fromTrigger } = beliefTerms(atom, vocab);
  if (terms.size === 0) return false;
  return countTermHits(terms, words) >= minTermHits(terms.size, fromTrigger, vocab.learned);
}

/** One preference as an agent-facing line. Says what it is, so it can never read as a requirement. */
export function renderUserPreferenceLine(atom: UserKnowledgeAtom): string {
  // The person is "This person", so a later "the user" can only be the users of what they build.
  const claim = agentFacingClaim(atom.claim).trim().replace(/\.$/, "");
  // A behavioural belief says so, because "learned from your edits" and "you told me" deserve different
  // weight from an agent deciding how hard to lean on it.
  const tag =
    atom.basis === "edits" ? "learned from their edits"
    : atom.basis === "choices" ? "learned from their choices"
    : atom.primitive === "procedure" ? "user procedure" : atom.primitive === "context" ? "user context" : "user preference";
  // The extractor often folds the condition into the claim already. Repeating it reads as a stutter and
  // spends tokens twice, so the prefix is added only when the claim does not already carry it.
  const triggers = atom.trigger_evidence.filter((t) => t.trim().length > 0);
  const lower = claim.toLowerCase();
  const missing = triggers.filter((t) => !lower.includes(t.trim().toLowerCase()));
  if (missing.length === 0) return `- ${claim}. [${tag}]`;
  const when = `When ${JSON.stringify(missing.join(", "))}, `;
  return `- ${when}${claim.charAt(0).toLowerCase()}${claim.slice(1)}. [${tag}]`;
}

/**
 * One preference, precompiled for the hook index.
 *
 * The hook is a standalone file with no dependencies beyond Node built-ins, so it cannot call any of
 * the logic above. Everything that decides anything therefore happens HERE, at compile time, and the
 * index carries the result: the rendered line, the terms that make it relevant, and whether it applies
 * unconditionally. The hook's whole job is to match terms against the prompt and carry the line through
 * the delivery and delta machinery it already has. No user-intelligence rule lives in the hook.
 */
export interface UserPreferenceEntry {
  id: string;
  line: string;
  /** Stemmed topic terms. Empty when `always` is true. */
  terms: string[];
  /** True for a belief with no condition (how to work with the person), which applies to any task. */
  always: boolean;
  /** Distinct terms the prompt must hit. Absent in indexes written before it existed, which means 1. */
  min?: number;
  /** Indexes written before `mayLowerVerification` carried such habits flagged; none are compiled now. */
  relaxes?: boolean;
  /** Workspace-relative path ("/packages/app") a narrowed belief holds under; the hook delivers it only there. */
  path?: string;
}

/**
 * Compile the deliverable, in-scope beliefs into index entries.
 *
 * Scope and eligibility are settled here because they do not depend on the prompt: a candidate, a
 * retired belief, or one pinned to another workspace can never become relevant later, so carrying it
 * to the hook would only invite a mistake there.
 */
/**
 * A habit that could mean LESS verification (dropping error handling, skipping a safety option) is never
 * delivered, on any task. Pausing it only on high-risk work needed "is this task risky?" decided from the
 * person's words, which a word list can only answer in the languages it lists. Withholding it everywhere
 * holds every person to the same rule, and the person can still say it outright on a task.
 */
export function mayLowerVerification(atom: UserKnowledgeAtom): boolean {
  return atom.relaxes_verification === true;
}

export function compileUserPreferenceEntries(
  atoms: readonly UserKnowledgeAtom[],
  where: UserKnowledgeWhere,
  vocabulary?: PersonVocabulary,
  /**
   * For an index written before the working path is known (`where.path` null): carry a belief the person
   * narrowed to a path, marked with that path, instead of leaving it out of every index.
   */
  options: { carryPathScope?: boolean } = {},
): UserPreferenceEntry[] {
  const out: UserPreferenceEntry[] = [];
  const vocab = vocabulary ?? learnPersonVocabulary(atoms);
  for (const atom of atoms) {
    if (!isUserKnowledgeDeliverable(atom)) continue;
    const narrowed = atom.applies_to_path?.replace(/^\/+|\/+$/g, "") ?? "";
    const path = options.carryPathScope && where.path == null && narrowed !== "" ? `/${narrowed}` : null;
    if (!userKnowledgeApplies(atom, path ? { ...where, path } : where)) continue;
    if (mayLowerVerification(atom)) continue;
    const always = appliesUnconditionally(atom);
    const { terms: termSet, fromTrigger } = beliefTerms(atom, vocab);
    const terms = always ? [] : [...termSet];
    const entry: UserPreferenceEntry = { id: atom.id, line: renderUserPreferenceLine(atom), terms, always };
    if (!always) entry.min = minTermHits(terms.length, fromTrigger, vocab.learned);
    if (path) entry.path = path;
    out.push(entry);
  }
  return out;
}

/** The heading the hook prints above the entries. Here so the wording stays with the rest of the layer. */
export const USER_PREFERENCE_HEADING =
  "## How this user prefers to work\nFollow these unless a rule, a required verification or a safety boundary says otherwise: those always win.";

/**
 * Compile the agent-facing block.
 *
 * Order is the authority statement: requirements are printed first, under a heading that calls them
 * required, and preferences come after under a heading that says they do not override anything. An
 * agent reading top to bottom meets the binding rules before it meets the person's taste.
 */
export function compileUserDelivery(input: UserDeliveryInput): UserDeliveryResult {
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
  const suppressed: UserDeliveryResult["suppressed"] = [];
  const candidates: UserKnowledgeAtom[] = [];
  const vocab = input.vocabulary ?? learnPersonVocabulary(input.atoms);

  for (const atom of input.atoms) {
    if (!isUserKnowledgeDeliverable(atom)) { suppressed.push({ atom, reason: "not_deliverable" }); continue; }
    if (!userKnowledgeApplies(atom, input.where)) { suppressed.push({ atom, reason: "out_of_scope" }); continue; }
    if (mayLowerVerification(atom)) { suppressed.push({ atom, reason: "risk_gate" }); continue; }
    if (!isRelevantToTask(atom, input.taskText, vocab)) { suppressed.push({ atom, reason: "not_relevant" }); continue; }
    candidates.push(atom);
  }

  // Strongest first, so a budget cut drops the weakest belief rather than an arbitrary one.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.claim.localeCompare(b.claim));

  const delivered = candidates.slice(0, maxItems);
  for (const atom of candidates.slice(maxItems)) suppressed.push({ atom, reason: "over_budget" });

  const requirements = input.requirements ?? [];
  const parts: string[] = [];
  if (requirements.length > 0) {
    parts.push("## Required by this workspace\nThese are not optional and are not affected by anything below.");
    for (const r of requirements) parts.push(r.line);
  }
  if (delivered.length > 0) {
    parts.push(USER_PREFERENCE_HEADING);
    for (const a of delivered) parts.push(renderUserPreferenceLine(a));
  }

  return { delivered, suppressed, text: parts.join("\n") };
}
