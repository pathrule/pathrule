// SPDX-License-Identifier: Apache-2.0
/**
 * Identity and lifecycle for USER knowledge: minting an atom, adding evidence to one that already
 * exists, superseding one the person outgrew, and correcting its scope. Node-only, because identity is
 * a SHA-256; the types and every gate live in `user-knowledge.ts`, which stays browser-safe so a browser surface
 * can import them without dragging crypto into the renderer bundle.
 *
 * Identity is deliberately over the CLAIM and the primitive, not over the evidence. The same preference
 * observed on three different days must land on ONE atom that grew stronger, not three near-duplicates,
 * because "you said this three times" is the signal that makes an inferred belief safe to act on.
 */
import { createHash } from "node:crypto";
import type { UserKnowledgeAtom, UserPrimitive } from "./user-knowledge.js";

/** Stable identity: primitive + normalised claim. Whitespace and case do not mint a second belief. */
export function userKnowledgeFingerprint(input: { primitive: UserPrimitive; claim: string }): string {
  const norm = input.claim.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(`${input.primitive}::${norm}`).digest("hex");
}

/**
 * Change of mind: a later belief replaces an earlier one.
 *
 * Deliberately NOT "newest always wins". The caller must name the replacement, which means something
 * established that these two beliefs actually conflict; recency alone never retires anything, and the
 * old atom is kept with a pointer so "why did that change" has an answer.
 */
export function supersedeUserKnowledge(atom: UserKnowledgeAtom, bySupersedingId: string, opts: { now: string }): UserKnowledgeAtom {
  return { ...atom, status: "retired", superseded_by: bySupersedingId, updated_at: opts.now };
}

/** The person says this belief is wrong. Kept, so the same evidence does not propose it again. */
export function rejectUserKnowledge(atom: UserKnowledgeAtom, opts: { now: string }): UserKnowledgeAtom {
  return { ...atom, status: "rejected", updated_at: opts.now };
}

/**
 * The person says where it applies: "that was just for that project", or "everywhere".
 *
 * This is the answer to over-learning, so it must be reachable from the UI in one step. Narrowing to a
 * workspace keeps the belief useful where it is true instead of forcing a delete, which is what makes
 * correction cheap enough that people actually do it. `workspace_id: null` is the person saying
 * "everywhere", which is recorded as such: a belief seen in one workspace otherwise stays there
 * (`effectiveUserWorkspace`), and only the person can overrule that before a second workspace does.
 */
export function narrowUserKnowledge(
  atom: UserKnowledgeAtom,
  to: { workspace_id?: string | null; path?: string | null },
  opts: { now: string },
): UserKnowledgeAtom {
  const next: UserKnowledgeAtom = {
    ...atom,
    applies_to_workspace_id: to.workspace_id === undefined ? atom.applies_to_workspace_id : to.workspace_id,
    applies_to_path: to.path === undefined ? atom.applies_to_path : to.path,
    updated_at: opts.now,
  };
  if (to.workspace_id === null) next.applies_everywhere = true;
  else if (to.workspace_id !== undefined) delete next.applies_everywhere;
  return next;
}
