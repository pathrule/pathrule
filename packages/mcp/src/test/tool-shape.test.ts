// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { tools, DEFERRED_WRITE_TOOL_NAMES, TOOL_ORDER, orderTools } from "../tools/index.js";
import type { ToolDef } from "../tools/types.js";

describe("tools/index.ts", () => {
  it("exports exactly 33 tools on its own including source-backed learning, review history, the knowledge map and runtime events", () => {
    expect(tools.length).toBe(33);
  });

  // A name here with no tool behind it is dead: setup, goto and the instrumentation pair lingered
  // for weeks after their tools were removed (2026-10-18).
  it("orders exactly its own 33 tools and names no tool that does not exist", () => {
    expect(TOOL_ORDER.length).toBe(33);
    expect(new Set(TOOL_ORDER).size).toBe(33);
    const own = new Set(tools.map((t) => t.name));
    expect(TOOL_ORDER.filter((name) => !own.has(name))).toEqual([]);
    expect(orderTools([]).map((t) => t.name)).toEqual(TOOL_ORDER);
    // Added last, so every earlier tool keeps its place in a cached tool list.
    expect(TOOL_ORDER.slice(-2)).toEqual(["pathrule_runtime_events", "pathrule_runtime_events_resolve"]);
  });

  it("advertises a plugin's unlisted tools last, in the order they came in", () => {
    const stub = (name: string): ToolDef => ({
      name,
      description: "stub",
      inputSchema: {},
      handler: async () => null,
    });
    const names = orderTools([stub("pathrule_zz_first"), stub("pathrule_aa_second")]).map(
      (t) => t.name,
    );
    expect(names.slice(0, TOOL_ORDER.length)).toEqual(TOOL_ORDER);
    expect(names.slice(-2)).toEqual(["pathrule_zz_first", "pathrule_aa_second"]);
    expect(() => orderTools([stub("pathrule_ping")])).toThrow(/Two MCP tools/);
  });

  it("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool name is snake_case and prefixed with pathrule_", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^pathrule_[a-z_]+$/);
    }
  });

  it("every tool has a non-empty title + description + inputSchema", () => {
    for (const t of tools) {
      expect(t.title?.length ?? 0, `${t.name} title`).toBeGreaterThan(0);
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(10);
      expect(typeof t.inputSchema, `${t.name} inputSchema`).toBe("object");
      expect(typeof t.handler, `${t.name} handler`).toBe("function");
    }
  });

  // Agents relay this text to people. Studio's Suggestions tab (removed 2026-10-08), the
  // `pathrule refresh` command and the generated patch proposals are gone; the copy kept them.
  it("no tool text sends anyone to a surface Pathrule no longer has", () => {
    // Case-sensitive: "Pathrule refresh task" names the task, `pathrule refresh` the removed command.
    const gone = /Suggestions tab|pathrule refresh|via realtime|pre-generated patch|in the Pathrule UI/;
    for (const t of tools) {
      const fields = Object.values(t.inputSchema as Record<string, { description?: string }>);
      const text = [t.description, ...fields.map((field) => field?.description ?? "")].join("\n");
      expect(text, t.name).not.toMatch(gone);
    }
  });

  it("includes all the canonical pathrule_* tool names", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "pathrule_delete_memory",
        "pathrule_delete_rule",
        "pathrule_delete_skill",
        "pathrule_get_context",
        "pathrule_get_node",
        "pathrule_get_refresh_brief",
        "pathrule_get_tree",
        "pathrule_import_pattern",
        "pathrule_knowledge_map",
        "pathrule_list_memories",
        "pathrule_list_pending_refreshes",
        "pathrule_log_activity",
        "pathrule_ping",
        "pathrule_record_learning",
        "pathrule_remember_preference",
        "pathrule_review_learning",
        "pathrule_review_history",
        "pathrule_read",
        "pathrule_read_memory",
        "pathrule_read_rule",
        "pathrule_read_skill",
        "pathrule_remove_pattern",
        "pathrule_request_refresh",
        "pathrule_resolve",
        "pathrule_resolve_refresh",
        "pathrule_runtime_events",
        "pathrule_runtime_events_resolve",
        "pathrule_update_memory",
        "pathrule_update_rule",
        "pathrule_update_skill",
        "pathrule_write_memory",
        "pathrule_write_rule",
        "pathrule_write_skill",
      ].sort(),
    );
  });

  // The deferred write/admin set is the lazy-mode gate. Guard it
  // against drift: every deferred name must be a real tool, and the always-on
  // remainder must include the read path + the mandatory log_activity loop.
  it("DEFERRED_WRITE_TOOL_NAMES is a subset of the ordered tools", () => {
    const names = new Set(TOOL_ORDER);
    for (const deferred of DEFERRED_WRITE_TOOL_NAMES) {
      expect(names.has(deferred), `${deferred} must be a known tool`).toBe(true);
    }
  });

  it("keeps the read path + log_activity always-on (never deferred)", () => {
    const alwaysOn = [
      "pathrule_review_learning",
      "pathrule_review_history",
      "pathrule_ping",
      "pathrule_get_context",
      "pathrule_get_tree",
      "pathrule_get_node",
      "pathrule_list_memories",
      "pathrule_resolve",
      "pathrule_read",
      "pathrule_knowledge_map",
      "pathrule_read_memory",
      "pathrule_read_rule",
      "pathrule_read_skill",
      "pathrule_list_pending_refreshes",
      "pathrule_get_refresh_brief",
      "pathrule_log_activity",
      "pathrule_runtime_events",
    ];
    for (const name of alwaysOn) {
      expect(DEFERRED_WRITE_TOOL_NAMES.has(name), `${name} must stay always-on`).toBe(false);
    }
    // Every tool is either always-on or deferred — no tool falls through.
    expect(DEFERRED_WRITE_TOOL_NAMES.size + alwaysOn.length).toBe(TOOL_ORDER.length);
  });
});
