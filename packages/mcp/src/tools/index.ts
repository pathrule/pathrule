// SPDX-License-Identifier: Apache-2.0
import { reviewLearningTool } from "./review-learning.js";
import { pingTool } from "./ping.js";
import { recordLearningTool } from "./record-learning.js";
import { rememberPreferenceTool } from "./remember-preference.js";
import { reviewHistoryTool } from "./review-history.js";
import { getContextTool } from "./get-context.js";
import { getTreeTool } from "./get-tree.js";
import { getNodeTool } from "./get-node.js";
import { resolveTool } from "./resolve.js";
import { readTool } from "./read.js";
import { knowledgeMapTool } from "./knowledge-map.js";
import { readSkillTool } from "./read-skill.js";
import { readRuleTool } from "./read-rule.js";
import { listMemoriesTool } from "./list-memories.js";
import { readMemoryTool } from "./read-memory.js";
import { writeMemoryTool } from "./write-memory.js";
import { updateMemoryTool } from "./update-memory.js";
import { deleteMemoryTool } from "./delete-memory.js";
import { writeRuleTool } from "./write-rule.js";
import { updateRuleTool } from "./update-rule.js";
import { deleteRuleTool } from "./delete-rule.js";
import { writeSkillTool } from "./write-skill.js";
import { updateSkillTool } from "./update-skill.js";
import { deleteSkillTool } from "./delete-skill.js";
import { importPatternTool, removePatternTool } from "./import-pattern.js";
import { logActivityTool } from "./activity-log.js";
import { listPendingRefreshesTool } from "./list-pending-refreshes.js";
import { getRefreshBriefTool } from "./get-refresh-brief.js";
import { resolveRefreshTool } from "./resolve-refresh.js";
import { requestRefreshTool } from "./request-refresh.js";
import { runtimeEventsResolveTool, runtimeEventsTool } from "./runtime-events.js";
import type { ToolDef } from "./types.js";

/**
 * The tools the open server exposes on its own. A plugin's tools are advertised after them
 * unless TOOL_ORDER names a slot for them; today no plugin adds one.
 *
 * `pathrule_suggest_skill` was removed: Claude now asks the user in natural
 * language first and calls `pathrule_write_skill` directly on confirmation —
 * the suggestion table became an orphaned UX with no good resolution path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tools: readonly ToolDef<any>[] = [
  pingTool,
  getContextTool,
  reviewHistoryTool,
  reviewLearningTool,
  getTreeTool,
  getNodeTool,
  // Cheap name/title → { id, version_id } lookup so edits skip the tree-walk id hunt.
  resolveTool,
  // Batch read many ids in one call (kills the get_node → N× read_* roundtrip storm).
  readTool,
  knowledgeMapTool,
  listMemoriesTool,
  readMemoryTool,
  writeMemoryTool,
  recordLearningTool,
  rememberPreferenceTool,
  updateMemoryTool,
  deleteMemoryTool,
  readRuleTool,
  writeRuleTool,
  updateRuleTool,
  deleteRuleTool,
  readSkillTool,
  writeSkillTool,
  updateSkillTool,
  deleteSkillTool,
  // Import / remove a published pattern bundle via ::pathrule:package:<slug>.
  importPatternTool,
  removePatternTool,
  logActivityTool,
  // AI handoff for stale memory/rule refresh tasks.
  listPendingRefreshesTool,
  getRefreshBriefTool,
  resolveRefreshTool,
  // Reverse channel: the AI flags a stale subject for the user.
  requestRefreshTool,
  // Runtime events an application reported (Local or Cloud), and a fix to verify against them.
  runtimeEventsTool,
  runtimeEventsResolveTool,
];

/**
 * The advertised order of every tool, the open server's and its plugins'. The list a client
 * receives must not depend on which composition built the server, beyond which tools exist:
 * context tools first (most-frequent), then reads, then writes grouped by kind, so
 * `tools/list` output reads naturally. A tool missing here is advertised last.
 */
export const TOOL_ORDER: readonly string[] = [
  "pathrule_ping",
  "pathrule_get_context",
  "pathrule_review_history",
  "pathrule_review_learning",
  "pathrule_get_tree",
  "pathrule_get_node",
  "pathrule_resolve",
  "pathrule_read",
  "pathrule_knowledge_map",
  "pathrule_list_memories",
  "pathrule_read_memory",
  "pathrule_write_memory",
  "pathrule_record_learning",
  "pathrule_remember_preference",
  "pathrule_update_memory",
  "pathrule_delete_memory",
  "pathrule_read_rule",
  "pathrule_write_rule",
  "pathrule_update_rule",
  "pathrule_delete_rule",
  "pathrule_read_skill",
  "pathrule_write_skill",
  "pathrule_update_skill",
  "pathrule_delete_skill",
  "pathrule_import_pattern",
  "pathrule_remove_pattern",
  // pathrule_understand was removed: get_context returns a depth-aware response
  // (minimal / focused / deep) driven by the router's context_depth.
  "pathrule_log_activity",
  "pathrule_list_pending_refreshes",
  "pathrule_get_refresh_brief",
  "pathrule_resolve_refresh",
  "pathrule_request_refresh",
  // Runtime events reads and corrections, after every earlier tool so cached tool prefixes hold.
  "pathrule_runtime_events",
  "pathrule_runtime_events_resolve",
];

/** The open tools plus the plugins' tools, in TOOL_ORDER. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function orderTools(pluginTools: readonly ToolDef<any>[]): ToolDef<any>[] {
  const all = [...tools, ...pluginTools];
  const seen = new Set<string>();
  for (const tool of all) {
    if (seen.has(tool.name)) throw new Error(`Two MCP tools are named ${tool.name}.`);
    seen.add(tool.name);
  }
  const rank = (name: string) => {
    const i = TOOL_ORDER.indexOf(name);
    return i === -1 ? TOOL_ORDER.length : i;
  };
  // Array.prototype.sort is stable, so unlisted tools keep the order they came in.
  return all.sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * The write/admin tools deferred behind `pathrule_enable_writes`
 * in lazy mode (`PATHRULE_MCP_TOOLS=lazy`, opt-in). The read set and
 * `pathrule_log_activity` stay always-on, so the hot read path and the
 * mandatory activity-log loop never pay an enable round-trip. Nothing is
 * removed: in `PATHRULE_MCP_TOOLS=all` mode every tool registers upfront,
 * and in lazy mode these become callable the moment `enable_writes` runs.
 *
 * Single source of truth — `enforce-deferred-subset` (tool-shape.test.ts)
 * guards that every name here is in TOOL_ORDER, so it can't drift.
 */
export const DEFERRED_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "pathrule_record_learning",
  "pathrule_remember_preference",
  "pathrule_write_memory",
  "pathrule_update_memory",
  "pathrule_delete_memory",
  "pathrule_write_rule",
  "pathrule_update_rule",
  "pathrule_delete_rule",
  "pathrule_write_skill",
  "pathrule_update_skill",
  "pathrule_delete_skill",
  "pathrule_import_pattern",
  "pathrule_remove_pattern",
  "pathrule_resolve_refresh",
  "pathrule_request_refresh",
  "pathrule_runtime_events_resolve",
]);

/**
 * The tools a session uses in the ordinary course of work, advertised upfront in `core` mode
 * (`PATHRULE_MCP_TOOLS=core`, not the default: see server.ts): reading what the hook named, saving
 * what was decided or learned, keeping an item current.
 * Everything else registers DISABLED behind `pathrule_more_tools`. Measured on PathruleBench v3
 * (2026-10-16): Claude Code lists every advertised tool's name in the prompt of every session and
 * loads a schema only on first use, so the list's cost is its names (34 names: ~3,900 characters a
 * session, re-read on every model step); a chain of 32 turns used six of them.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "pathrule_get_context",
  "pathrule_read_memory",
  "pathrule_read_rule",
  "pathrule_read_skill",
  "pathrule_resolve",
  "pathrule_write_memory",
  "pathrule_update_memory",
  "pathrule_write_rule",
  "pathrule_update_rule",
  "pathrule_remember_preference",
  "pathrule_import_pattern",
  "pathrule_log_activity",
  "pathrule_ping",
]);

export type { ToolDef } from "./types.js";
