// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mcpMilestones, observeToolForTelemetry } from "./tool-telemetry.js";

describe("MCP install-funnel milestones", () => {
  it("names the agent or the kind of knowledge, nothing the agent sent", () => {
    expect(mcpMilestones("pathrule_get_context", "claude-code")).toEqual([
      { eventName: "mcp_used", featureTag: "claude_code" },
      { eventName: "context_delivered", featureTag: "claude_code" },
    ]);
    expect(mcpMilestones("pathrule_update_rule", null)).toEqual([
      { eventName: "mcp_used", featureTag: "unknown" },
      { eventName: "knowledge_written", featureTag: "rule" },
    ]);
    expect(mcpMilestones("pathrule_read_memory", "Cursor IDE")).toEqual([
      { eventName: "mcp_used", featureTag: "cursor_ide" },
    ]);
  });

  it("records a successful call once per day as an MCP event, and a failed one not at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-mcp-telemetry-"));
    const env = { PATHRULE_HOME: root };
    // A signed-in account: the local product records nothing (open-core decision 12).
    writeFileSync(
      join(root, "native-session.json"),
    JSON.stringify({
      schema_version: 1,
      base_url: "https://cloud.pathrule.io",
      user_id: "user-1",
      token: "t",
      expires_at: "2100-01-01T00:00:00.000Z",
      updated_at: "2026-10-17T00:00:00.000Z",
    }),
      { mode: 0o600 },
    );
    // The person turned telemetry on: nothing is collected before that.
    writeFileSync(
      join(root, "telemetry.json"),
      JSON.stringify({ schema_version: 1, pseudonymous_install_id: "i", telemetry_enabled: true }),
      { mode: 0o600 },
    );
    try {
      await observeToolForTelemetry({ tool: "pathrule_write_memory", ok: false, client: "codex" }, env);
      await observeToolForTelemetry({ tool: "pathrule_write_memory", ok: true, client: "codex" }, env);
      await observeToolForTelemetry({ tool: "pathrule_write_skill", ok: true, client: "codex" }, env);
      const events = (await readFile(join(root, "logs", "telemetry-queue.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((e) => [e.event_name, e.feature_tag, e.surface])).toEqual([
        ["mcp_used", "codex", "mcp"],
        ["knowledge_written", "memory", "mcp"],
        ["knowledge_written", "skill", "mcp"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
