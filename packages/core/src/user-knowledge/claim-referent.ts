// SPDX-License-Identifier: Apache-2.0
/**
 * Keep "the user" from meaning two people in one line an agent reads.
 *
 * Every claim is written in English, in the third person, about the PERSON ("The user prefers ..."), so
 * the model has no word left for the users of what the person builds. When the person talks about those
 * users, the claim silently turns them into the person. Measured on a real store: a sentence about not
 * showing errors to END users became "The user prefers to solve problems internally without showing
 * errors to the user", which an agent reads as "do not show ME errors", in conflict with reporting
 * failures honestly.
 *
 * The fix is on Pathrule's own sentence, never on the person's words: the opening subject is renamed to
 * "This person", so any later "the user" can only be someone else. That works the same for a person
 * writing in any language, because every claim is the same English sentence shape (the extraction
 * contract asks for English). A word list over the person's text could only have caught the languages
 * on it.
 *
 * Agent-facing and deterministic. The stored claim keeps its wording, so its identity (the fingerprint)
 * does not move and the same belief still grows instead of forking; the person sees their belief as it
 * was stored.
 */

/** The opening subject of a claim about the person: "The user", "User". */
const SUBJECT = /^\s*(?:the\s+)?user\b/i;

/** The claim as an agent should read it: the person is "This person", so "the user" is someone else. */
export function agentFacingClaim(claim: string): string {
  return claim.replace(SUBJECT, "This person");
}
