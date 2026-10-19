// SPDX-License-Identifier: Apache-2.0
/**
 * A turn's Pathrule context: the block a surface prepends to its agent's instructions before a turn,
 * as the Pathrule host compiles it. The block has a stable half (the workspace bootstrap
 * and index, versioned so a conversation that already holds it is not sent it again) and a dynamic
 * half (the knowledge for this request).
 */

/** One memory, rule or skill whose body the turn runs on. */
export interface TurnContextAttribution {
  kind: "memory" | "rule" | "skill";
  /** The item's Pathrule id. */
  id: string;
  title: string;
  /** The text the agent received for it. */
  body: string;
  source: "injected";
  /**
   * In force for this turn but left out of its delta, because an earlier turn of the same
   * conversation already delivered this version.
   */
  carried?: boolean;
  /** Set by an account's after-render step: the account learned that this memory helps here. */
  affinity?: boolean;
  /** With `affinity`: more than one person works in the workspace, so the signal is the team's. */
  provenByTeam?: boolean;
}

export interface TurnContextMetrics {
  stableChars: number;
  dynamicChars: number;
  totalChars: number;
  deliveredItems: number;
  omittedKnownItems: number;
  routeDepth?: "minimal" | "focused" | "deep";
  retrievalMode?: "minimal" | "semantic" | "lexical" | "fail_closed";
}

export interface TurnContext {
  block: string;
  /** Versioned, workspace-stable protocol and navigation index. */
  stableBlock: string;
  /** Per-intent knowledge delta. Never contains the raw user message. */
  dynamicBlock: string;
  /**
   * Content hash of the stable block's source material, also when the stable block is omitted
   * because the caller already holds this version.
   */
  stableVersion: string;
  /** Content hashes of the bodies and sections actually delivered. */
  itemVersions: string[];
  metrics: TurnContextMetrics;
  /** The items whose bodies were delivered or carried. */
  attributions: TurnContextAttribution[];
}

/** What a surface asks for one turn. */
export interface TurnContextRequest {
  /** The agent's working folder. */
  workspaceRoot: string;
  /** The thread's node path; the project-learning scope when set. */
  nodePath?: string | null;
  /** The request's text. It selects the knowledge and is never rendered. */
  userIntent?: string;
  /** The surface asking, for instance "chat" or "tasks". It partitions the cache; account sections see it. */
  surface?: string;
  /** The stable half this conversation already holds; matching, it is left out. */
  knownStableVersion?: string;
  /** Versions of bodies and sections this conversation already holds; matching, they are carried. */
  knownItemVersions?: string[];
  /**
   * The person's setting for asking agents to check a library's docs first. Absent: the caller's
   * setting, or allowed when it has none.
   */
  leaseRequests?: boolean;
}
