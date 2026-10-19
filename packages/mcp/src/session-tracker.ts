// SPDX-License-Identifier: Apache-2.0
// In-memory session tracking — lives for the lifetime of one MCP server
// process (= one AI coding session). Tracks protocol compliance and injects
// a targeted warning when Claude forgets log_activity after several writes.
//
// Simplified. The old "warn if understand not called" heuristic is
// removed — pathrule_understand no longer exists, and the hook layer plus
// depth-aware get_context make "forgetting" to orient much less costly.

interface SessionState {
  getContextCalled: boolean;
  /** Counts mutating Pathrule calls since the last log_activity. Resets on log. */
  mutatingCallsSinceLastLog: number;
}

const state: SessionState = {
  getContextCalled: false,
  mutatingCallsSinceLastLog: 0,
};

// pathrule_enable_writes is a session-mechanism tool, not a data
// op — skip it so it neither bumps the mutating counter nor triggers reminders.
const SKIP_TOOLS = new Set(["pathrule_ping", "pathrule_enable_writes"]);
const MUTATING_TOOLS = new Set([
  "pathrule_write_memory",
  "pathrule_write_rule",
  "pathrule_write_skill",
  "pathrule_update_memory",
  "pathrule_update_rule",
  "pathrule_update_skill",
  "pathrule_delete_memory",
  "pathrule_delete_rule",
  "pathrule_delete_skill",
  "pathrule_resolve_refresh",
]);

/** Call BEFORE executing the handler — updates state. */
export function recordToolCall(toolName: string): void {
  if (SKIP_TOOLS.has(toolName)) return;

  if (toolName === "pathrule_get_context") {
    state.getContextCalled = true;
  } else if (toolName === "pathrule_log_activity") {
    state.mutatingCallsSinceLastLog = 0;
    return; // don't bump counter on the log call itself
  }

  if (MUTATING_TOOLS.has(toolName)) state.mutatingCallsSinceLastLog++;
}

/** Call AFTER recordToolCall — returns warnings to inject (may be empty). */
export function getWarnings(toolName: string): string[] {
  if (SKIP_TOOLS.has(toolName) || toolName === "pathrule_get_context") {
    return [];
  }

  // No log_activity reminder: the hook records file changes itself, and the reminder sent agents on
  // an extra tool step that contradicted the protocol ("recorded automatically"). The counter stays
  // for the session stats.
  return [];
}
