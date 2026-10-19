// SPDX-License-Identifier: Apache-2.0
/**
 * USER knowledge atoms: how this PERSON works, as opposed to how a workspace works.
 *
 * This is the user-scoped layer of the SAME knowledge architecture, not a second ontology. It reuses
 * the primitive names already in production (SELECTION, PROCEDURE, CONTEXT) and inherits REMEDY's and
 * SELECTION's two safety rules verbatim, because the failure mode is identical and worse here: turning
 * one sentence a person said in one task into a permanent belief about how they always work.
 *
 * Three invariants this file exists to hold:
 *
 *  1. GROUNDED. Every claim span must be byte-present in what the USER actually wrote. The model may
 *     not paraphrase a person into a preference they never expressed. Ungrounded means abstain, never
 *     store. This is FALSE_USER_KNOWLEDGE = 0.
 *  2. ADVISORY ONLY. User knowledge shapes collaboration. It is never compiled, never enforced, never
 *     executed, and it can never become a CONSTRAINT or CHECK. It cannot license breaking a workspace
 *     rule, and it never denies the alternative. Hence the primitive set here deliberately excludes
 *     CONSTRAINT and CHECK: see `USER_PRIMITIVES`.
 *  3. NOT GLOBALIZED ON ONE EVENT. "Do not write tests for this prototype" is a task instruction, not
 *     a life philosophy. Becoming a durable belief requires either an EXPLICIT persistent teaching,
 *     the person stating it as a lasting way of working ("a habit of mine: ...", which holds at once in
 *     the workspace where it was said, see `stated_lasting`), or repeated evidence from separate pieces
 *     of work, and travelling to OTHER workspaces requires having been seen in two of them (see
 *     `effectiveUserWorkspace`). Every gate is STRUCTURAL (the channel
 *     it was said in, distinct threads, distinct workspaces) and none reads the person's language, so
 *     a person writing in any language meets exactly the same rules. This is FALSE_GLOBALIZATION.
 *
 * Scope and authority stay separate concepts, exactly as they are for workspace knowledge. `scope`
 * answers "where does this apply"; it does NOT grant authority. A user SELECTION at scope USER still
 * loses to a workspace CHECK, which is asserted in the authority layer, not here.
 */
/**
 * The primitives that make sense for a person rather than a repository. CONSTRAINT and CHECK are
 * deliberately absent: a user-scoped prohibition or required verification would be an executable claim
 * about the world, and the enforcement pipeline belongs to the workspace. A person saying "never ask me
 * questions" is collaboration guidance, and it is stored as CONTEXT, never as a runtime block.
 */
export type UserPrimitive = "selection" | "procedure" | "context";
export const USER_PRIMITIVES: readonly UserPrimitive[] = ["selection", "procedure", "context"];

/**
 * How Pathrule came to believe this.
 *
 * EXPLICIT - the person deliberately TAUGHT Pathrule (Settings, `pathrule me teach`, asking Pathrule
 *            to remember) and the extractor read it as a durable way of working. Something said to an
 *            agent in the middle of a piece of work is never EXPLICIT, however it is phrased: it is
 *            about that work until it recurs in another one (see `isDeliberateTeaching`).
 * INFERRED - Pathrule watched what happened (a correction, a repeated choice) and proposed a claim.
 */
export type UserSourceType = "EXPLICIT" | "INFERRED";
export const USER_SOURCE_TYPES: readonly UserSourceType[] = ["EXPLICIT", "INFERRED"];

/**
 * Lifecycle. `candidate` is the resting state for anything weak: it is visible to the person and is
 * NEVER delivered to an agent. `retired` is a belief the person outgrew or corrected away; it is kept
 * so the same evidence does not immediately return as a new proposal, and so "why did that change"
 * stays answerable.
 */
export type UserKnowledgeStatus = "candidate" | "active" | "retired" | "rejected";
export const USER_KNOWLEDGE_STATUSES: readonly UserKnowledgeStatus[] = ["candidate", "active", "retired", "rejected"];

/** Deliberately coarse. A three-step ladder that a person can reason about beats a fake probability. */
export type UserConfidence = "low" | "medium" | "high";

/**
 * What kind of moment produced an observation.
 *
 * `edit` and `choice` are BEHAVIOUR rather than words: the person changed what the agent wrote, or picked
 * one of several alternatives the agent laid out with their trade-offs. Neither carries a quote the person
 * typed, so neither can pass the word-grounding gate; they are grounded in counted episodes instead (see
 * `user-behavior.ts`), and they only ever produce INFERRED beliefs.
 */
export type UserEvidenceKind = "teaching" | "correction" | "decision" | "edit" | "choice";

/**
 * Where an observation was made. `voice` is a TRANSCRIPT rather than something the person typed, which is
 * why it can never carry EXPLICIT confidence (see `transcribed` on the engine's observation source).
 * Evidence written by earlier builds says `twin-voice` for the same thing: test with `isSpokenEvidence`,
 * never by comparing the string.
 */
export type UserEvidenceSurface = "studio" | "cli" | "voice";

/** The words were spoken and transcribed, under either name a stored observation may carry. */
export function isSpokenEvidence(surface: string): boolean {
  return surface === "voice" || surface === "twin-voice";
}

/**
 * Where a belief came from. Absent means `words`, which is every belief stored before behaviour existed.
 *
 *  - words:   something the person said (the grounded extraction path).
 *  - edits:   how they changed the agent's code afterwards, counted over separate pieces of work.
 *  - choices: which alternative they picked when shown the trade-offs, which is the one kind of
 *             observation that separates "prefers this" from "did not know there was another way".
 */
export type UserKnowledgeBasis = "words" | "edits" | "choices";

/**
 * The counts behind a behavioural belief, kept so its confidence is a rate rather than a vibe.
 *
 * `opportunities` are occasions on which the behaviour COULD have happened (the agent added a comment the
 * person could have deleted; a choice offered the trait), `occurrences` the ones on which it did. A
 * person who keeps the agent's comments nine times out of ten has shown something too, and only a rate
 * over opportunities can say so.
 */
export interface UserBehaviorStats {
  opportunities: number;
  occurrences: number;
  /** Distinct workspaces that contributed an occurrence. Two or more is what lets a belief travel. */
  workspaces: number;
  /** Distinct pieces of work (threads) that contributed an occurrence. */
  threads: number;
}

/**
 * One observation backing a claim, pointing at where it happened so "why do you think this?" has a
 * real answer. `quote` is the person's OWN words, verbatim, and is what grounding is checked against.
 * The workspace id is where it was said. A belief learned from words in only one workspace applies only
 * there until a second workspace shows it too (see `effectiveUserWorkspace`).
 */
export interface UserEvidence {
  kind: UserEvidenceKind;
  quote: string;
  observed_at: string;
  /** Where it was said. */
  surface: UserEvidenceSurface;
  workspace_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  /** The person was teaching Pathrule on purpose, not talking to an agent about the work. Absent on
   *  evidence stored before the flag existed; see `isDeliberateTeaching` for how that is read. */
  taught?: boolean;
}

/** What the write path hands in. Identity, confidence, status and timestamps are derived. */
export interface UserKnowledgeInput {
  primitive: UserPrimitive;
  /** The agent-facing sentence. Composed wording is allowed here; it is never treated as evidence. */
  claim: string;
  /** Verbatim spans from the person's own words that carry the claim. At least one is required. */
  claim_evidence: string[];
  /** Verbatim spans naming WHEN it applies ("for architectural work"). Empty means it always applies. */
  trigger_evidence: string[];
  source_type: UserSourceType;
  /** The first observation. More arrive through `addUserEvidence`. */
  evidence: UserEvidence;
  /** Narrowing, both optional. Set by an explicit scope correction, never inferred. */
  applies_to_workspace_id?: string | null;
  applies_to_path?: string | null;
}

/** Stored shape. */
export interface UserKnowledgeAtom {
  id: string;
  kind: "user_knowledge";
  primitive: UserPrimitive;
  /** Always "user". Present so a mixed delivery set can be filtered without inspecting `kind`. */
  scope: "user";
  claim: string;
  claim_evidence: string[];
  trigger_evidence: string[];
  source_type: UserSourceType;
  evidence: UserEvidence[];
  confidence: UserConfidence;
  status: UserKnowledgeStatus;
  /** Set by the person ("only here"). Null means no narrowing; where it applies is then
   *  `effectiveUserWorkspace`, which keeps a belief seen in one workspace with that workspace. */
  applies_to_workspace_id: string | null;
  /** The person said it applies in every workspace. Without it, a belief learned from words in one
   *  workspace stays there until a second workspace shows it too. */
  applies_everywhere?: boolean;
  /** The person said it holds for all the work they ask for ("for any code you write for me"): no
   *  topic gates it. Distinct from a missing trigger, which still has to match the claim's topic. */
  applies_always?: boolean;
  /**
   * The person stated it as a lasting way of working ("a habit of mine: ...", "from now on, ..."), not a
   * remark about the task at hand: active at once, in the workspace where it was said. The agent in
   * the session judges that, in any language. Measured on PathruleBench v2 (2026-10-15): a habit left
   * a candidate until a second session reached no agent, and a CLAUDE.md user had it from the next
   * session on. Travelling to other workspaces still needs a second one (`effectiveUserWorkspace`).
   */
  stated_lasting?: boolean;
  /** Null means every path. Uses the same ancestor semantics as workspace scope. */
  applies_to_path: string | null;
  created_at: string;
  updated_at: string;
  last_observed_at: string;
  /** Set when a later belief replaced this one, so change of mind stays explainable. */
  superseded_by: string | null;
  fingerprint: string;
  /** Where the belief came from. Absent means `words`. */
  basis?: UserKnowledgeBasis;
  /** The rate behind a behavioural belief. Absent for beliefs learned from words. */
  stats?: UserBehaviorStats;
  /**
   * Following this belief could mean LESS verification (dropping error handling, skipping a safety
   * option). Such a belief is paused on high-risk work: a habit is never allowed to lower the bar where a
   * mistake is silent and expensive, whatever the evidence behind it says about the person.
   */
  relaxes_verification?: boolean;
}

export type UserKnowledgeValidationCode =
  | "user_no_claim"
  | "user_no_claim_evidence"
  | "user_claim_not_grounded"
  | "user_trigger_not_grounded"
  | "user_primitive_unknown"
  | "user_source_type_unknown"
  | "user_evidence_missing"
  | "user_sensitive_domain"
  | "user_executable_claim"
  | "user_workspace_fact";

export type UserKnowledgeValidation =
  | { ok: true; value: UserKnowledgeInput }
  | { ok: false; code: UserKnowledgeValidationCode; message: string };

function workspaceKey(id: string | null | undefined): string | null {
  const k = (id ?? "").trim().replace(/(.)\/+$/, "$1");
  return k === "" ? null : k;
}

/**
 * The one workspace a belief applies in, or null for every workspace.
 *
 * Invariance, the rule behaviour already follows: a habit seen in one workspace may be that project's
 * convention rather than the person's, and only a second workspace tells the two apart. So a belief
 * learned from WORDS in one workspace applies there until another workspace shows it too. Before this,
 * every belief travelled everywhere from its first observation: on a real store all 32 beliefs applied
 * in every workspace although their evidence came from four, and "every night, scan packages/app-store"
 * from one demo repository reached all of them.
 *
 * The person's word wins over the rule in both directions: "only here" pins a belief
 * (`applies_to_workspace_id`), "everywhere" frees it (`applies_everywhere`). Behavioural beliefs carry
 * their own invariance in `applies_to_workspace_id` (see `user-behavior.ts`) and pass through unchanged.
 * Evidence with no workspace (a teaching from the CLI or Settings) pins nothing.
 */
export function effectiveUserWorkspace(atom: UserKnowledgeAtom): string | null {
  if (atom.applies_to_workspace_id !== null) return atom.applies_to_workspace_id;
  if (atom.applies_everywhere === true) return null;
  if ((atom.basis ?? "words") !== "words") return null;
  const seen = new Set<string>();
  for (const e of atom.evidence) {
    const k = workspaceKey(e.workspace_id);
    if (k) seen.add(k);
  }
  return seen.size === 1 ? [...seen][0]! : null;
}

/** Where the work is happening. Aliases are other names for the same workspace (its root path). */
export interface UserKnowledgeWhere {
  workspace_id: string | null;
  path: string | null;
  /**
   * Observations record the workspace by the gateway's key, which for a folder-bound workspace is its root
   * PATH, while delivery knows it by id. Callers that know the root pass it here so a belief recorded
   * either way finds its workspace. Compared exactly: a miss withholds a belief, never misplaces one.
   */
  workspace_aliases?: readonly (string | null | undefined)[];
}

function isSameWorkspace(pin: string, where: UserKnowledgeWhere): boolean {
  const target = workspaceKey(pin);
  if (target === null) return false;
  if (workspaceKey(where.workspace_id) === target) return true;
  return (where.workspace_aliases ?? []).some((a) => workspaceKey(a) === target);
}

/** Would this reach an agent? Active, not superseded, and not a low-confidence guess. */
export function isUserKnowledgeDeliverable(atom: UserKnowledgeAtom): boolean {
  return atom.status === "active" && atom.superseded_by === null && atom.confidence !== "low";
}

/**
 * Does this claim apply to the work happening right now?
 *
 * A belief the person holds everywhere travels with them across workspaces, which is the point of the
 * layer; one seen in a single workspace stays there (`effectiveUserWorkspace`). An explicit scope
 * correction ("only for this repository") pins it to one workspace, and an optional path narrows it
 * further using the same ancestor semantics workspace scope uses.
 */
export function userKnowledgeApplies(atom: UserKnowledgeAtom, where: UserKnowledgeWhere): boolean {
  const pin = effectiveUserWorkspace(atom);
  if (pin !== null && !isSameWorkspace(pin, where)) return false;
  if (atom.applies_to_path !== null) {
    const s = atom.applies_to_path.replace(/^\/+|\/+$/g, "");
    if (s !== "") {
      if (where.path == null) return false;
      const p = where.path.replace(/^\/+|\/+$/g, "");
      if (p !== s && !p.startsWith(s + "/")) return false;
    }
  }
  return true;
}
