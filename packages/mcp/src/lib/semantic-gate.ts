// SPDX-License-Identifier: Apache-2.0
// Whether a get_context call should look for semantic candidates at all. The search itself is the
// account edition's (the backend's `semanticCandidates`); this gate is the open half.

import type {
  ContextDepth,
  DeterministicRoute,
  RoutingResult,
} from "@pathrule/protocol/routing-types.js";

export interface SemanticGateInput {
  userIntentProvided: boolean;
  deterministic: DeterministicRoute | undefined;
  routing: RoutingResult;
  depth: ContextDepth;
}

/**
 * Decide whether semantic search should run for this get_context call.
 *
 * Phase 5+ adjustment after the mudavim quality replay:
 *   * `known_area_bug` is now allowed on minimal/focused depths — the live
 *     data showed these prompts are genuinely discovery-shaped (e.g. "Brand
 *     PNG format requirement" with target rank 1, sim 0.51).
 *   * `depth === "deep"` is no longer a blanket skip. Deep prompts can still
 *     be discovery — `architecture_discovery`, `workspace_inventory`,
 *     `history_question`, or `unknown` with a discovery-ish task_shape — and
 *     the briefing they get back isn't a substitute for semantic recall.
 *     Other deep intents stay skipped because the deep briefing already
 *     surfaces what they need.
 *   * `execute_only` and `known_file_edit` remain hard skips. The user is on
 *     a known target; semantic noise is unhelpful and adds latency.
 *   * `known_area_ui` is allowed on minimal/focused depths. The deterministic
 *     bucket catches broad UI/domain discovery ("theme file", "brand colors")
 *     as well as edit-adjacent language; `known_file_edit` is the hard skip
 *     for concrete file work.
 */
export function shouldSearchSemanticCandidates(input: SemanticGateInput): boolean {
  if (!input.userIntentProvided) return false;
  const intentClass = input.deterministic?.intent_class;
  const taskShape = input.routing.decision?.task_shape;

  // Hard skips — same regardless of depth.
  if (intentClass === "execute_only") return false;
  if (intentClass === "known_file_edit") return false;

  if (input.depth === "deep") {
    // Narrow allow-list on deep depth.
    if (intentClass === "architecture_discovery") return true;
    if (intentClass === "workspace_inventory") return true;
    if (intentClass === "history_question") return true;
    if (intentClass === "unknown" || intentClass === undefined) {
      return taskShape === "discovery" || taskShape === "debug" || taskShape === "unknown";
    }
    return false;
  }

  // minimal / focused depth.
  if (intentClass === "known_area_bug") return true; // newly allowed
  if (intentClass === "known_area_ui") return true; // domain/UI discovery can need memory recall
  if (
    intentClass === "workspace_inventory" ||
    intentClass === "architecture_discovery" ||
    intentClass === "recent_activity_question" ||
    intentClass === "history_question" ||
    intentClass === "unknown" ||
    intentClass === undefined
  ) {
    return true;
  }
  return taskShape === "discovery" || taskShape === "debug" || taskShape === "unknown";
}
