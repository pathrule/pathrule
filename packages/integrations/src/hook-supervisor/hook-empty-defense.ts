// SPDX-License-Identifier: Apache-2.0
// Empty hook payload defense.
//
// Earlier telemetry showed 47 UserPromptSubmit events in a 34-day window where
// rule_count = 0 AND memory_count = 0 (no skills either). Each was a wasted
// round-trip that emitted `{}` to stdout with no benefit to the agent.
//
// This module provides:
//   1. `shouldSuppressEmptyPayload()` — returns true when the assembled payload
//      would be empty (no rules, no memories, no skills, no generic reminder).
//   2. Counters for telemetry: `hook_empty_skipped`, per-cause sub-counters.
//
// The counter map is in-process only — it resets on process restart. For
// production observability, the hook script flushes these to the injection log
// so a reader of that log can aggregate them.

// ─────────────────────────────────────────────────────────────────────────────
// Counters (in-process, reset on restart)
// ─────────────────────────────────────────────────────────────────────────────

const _counters = new Map<string, number>([
  ["hook_empty_skipped", 0],
  ["hook_empty_no_workspace", 0],
  ["hook_empty_all_filtered", 0],
]);

export function incrementCounter(
  key: "hook_empty_skipped" | "hook_empty_no_workspace" | "hook_empty_all_filtered",
): void {
  _counters.set(key, (_counters.get(key) ?? 0) + 1);
}

export function getCounter(
  key: "hook_empty_skipped" | "hook_empty_no_workspace" | "hook_empty_all_filtered",
): number {
  return _counters.get(key) ?? 0;
}

/** Return a snapshot of all counters. Read-only — does not reset. */
export function getCounterSnapshot(): Record<string, number> {
  return Object.fromEntries(_counters);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core decision
// ─────────────────────────────────────────────────────────────────────────────

export interface EmptyPayloadCheckInput {
  injectedRulesCount: number;
  injectedMemoriesCount: number;
  injectedSkillsCount: number;
  /**
   * True when the payload carries a generic reminder (workspace_id metadata,
   * session digest, path hint) even when no specific rules/memories/skills
   * were selected. The generic reminder has value — do not suppress.
   */
  hasGenericReminder: boolean;
  /**
   * Cause hint for counter attribution.
   * 'no_workspace'   — workspace_id unknown / workspace deleted/archived.
   * 'all_filtered'   — candidates existed but all were filtered out.
   * undefined        — unknown / caller did not specify.
   */
  causeHint?: "no_workspace" | "all_filtered";
}

/**
 * Returns true when the hook payload should be suppressed entirely.
 *
 * Suppress when:
 *   - total items (rules + memories + skills) == 0
 *   - AND there is no generic reminder that adds value on its own
 *
 * When suppressed, increments `hook_empty_skipped` and the per-cause counter.
 * The caller MUST emit `{}` or nothing — NOT a full additionalContext payload.
 */
export function shouldSuppressEmptyPayload(input: EmptyPayloadCheckInput): boolean {
  const totalItems =
    input.injectedRulesCount + input.injectedMemoriesCount + input.injectedSkillsCount;

  if (totalItems > 0 || input.hasGenericReminder) {
    return false;
  }

  // Truly empty — increment counters and signal suppression.
  incrementCounter("hook_empty_skipped");
  if (input.causeHint === "no_workspace") {
    incrementCounter("hook_empty_no_workspace");
  } else {
    incrementCounter("hook_empty_all_filtered");
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Reset all counters. For use in tests only. */
export function __resetCountersForTests(): void {
  for (const key of _counters.keys()) {
    _counters.set(key, 0);
  }
}
