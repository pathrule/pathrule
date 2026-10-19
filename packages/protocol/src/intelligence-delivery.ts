// SPDX-License-Identifier: Apache-2.0
/**
 * The vocabulary every delivery surface shares for the Intelligence that is not a knowledge item:
 * the person's guidance (User Intelligence) and an account's team and personal profiles (Team
 * Intelligence). The host's compiled turn, MCP `get_context` and the hook index use these, so a
 * section has one version wherever it travels and a surface that already delivered it can say so.
 *
 * Nothing here selects or ranks: the engine selects the guidance, the account's provider ranks the
 * profiles. This is only what the result is called.
 */

import { stableHash } from "./versioning.js";

/** What a selection is made for: a coding agent's session is "chat", a task run is "tasks". */
export type IntelligenceSurface = "chat" | "tasks";

/** A surface name as a provider reads it: anything but "tasks" is "chat", as the provider does. */
export function intelligenceSurface(surface: string | null | undefined): IntelligenceSurface {
  return surface === "tasks" ? "tasks" : "chat";
}

/**
 * The item version of a rendered profile block. The host's compiled turn has used this exact
 * formula since Studio, so a conversation's known versions stay valid on every surface.
 */
export function intelligenceItemVersion(surface: string, block: string): string {
  return `intelligence:${stableHash({ surface, intelligenceBlock: block })}`;
}

/** The item version of the person's rendered guidance for one request. */
export function userGuidanceItemVersion(text: string): string {
  return `user-guidance:${stableHash(text)}`;
}

/**
 * The longest profile block the hook index carries. It rides the session start beside the
 * protocol and the team block, which clients cap at about 10 KB in total. Entries that do not fit
 * stay out of the index (and out of its `ids`), so `get_context` still delivers them.
 */
export const HOOK_PROFILE_BLOCK_MAX_CHARS = 3_000;

/**
 * An account's team and personal profiles for one identity and one workspace: selected and ranked by
 * the account's provider, rendered by the account. An empty `block` means there is nothing to deliver.
 */
export interface IntelligenceProfileDelivery {
  /** The authenticated identity the selection was made for. Personal entries are this person's only. */
  owner: string;
  surface: IntelligenceSurface;
  /** The rendered section; "" when nothing is deliverable. */
  block: string;
  /** `intelligenceItemVersion(surface, block)`; "" with an empty block. */
  version: string;
  /** The profile entries rendered in `block`, in order. Never their evidence. */
  ids: string[];
}
