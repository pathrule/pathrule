// SPDX-License-Identifier: Apache-2.0
// The install funnel's MCP half (the CLI's telemetry module holds the rest): the MCP server in use,
// knowledge written through it and context delivered by it. Each is recorded at most once per UTC
// day per tag, so the same events answer "did this install get there" and "was it active today".
//
// The tag is the connected agent (claude_code, cursor, codex, ...) or the kind of knowledge written,
// never a tool argument, a path or anything the agent sent. A failed call records nothing.

import { recordDailyCliTelemetryEvent, type CliTelemetryEventName } from "../cli/telemetry.js";

declare const __PATHRULE_CLI_VERSION__: string;

const WRITTEN_KIND: Record<string, string> = {
  pathrule_write_memory: "memory",
  pathrule_update_memory: "memory",
  pathrule_write_rule: "rule",
  pathrule_update_rule: "rule",
  pathrule_write_skill: "skill",
  pathrule_update_skill: "skill",
  pathrule_record_learning: "learning",
  pathrule_import_pattern: "pattern",
};

export function mcpMilestones(
  tool: string,
  client: string | null,
): Array<{ eventName: CliTelemetryEventName; featureTag: string }> {
  const agent =
    (client ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "unknown";
  const out: Array<{ eventName: CliTelemetryEventName; featureTag: string }> = [
    { eventName: "mcp_used", featureTag: agent },
  ];
  if (tool === "pathrule_get_context") out.push({ eventName: "context_delivered", featureTag: agent });
  const kind = WRITTEN_KIND[tool];
  if (kind) out.push({ eventName: "knowledge_written", featureTag: kind });
  return out;
}

/** `McpPlugin.toolCompleted` for the compositions with Pathrule Cloud. Fire and forget. */
export function observeToolForTelemetry(
  event: { tool: string; ok: boolean; client: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!event.ok) return Promise.resolve();
  const appVersion = typeof __PATHRULE_CLI_VERSION__ !== "undefined" ? __PATHRULE_CLI_VERSION__ : "dev";
  return (async () => {
    for (const milestone of mcpMilestones(event.tool, event.client)) {
      await recordDailyCliTelemetryEvent(env, { ...milestone, appVersion, surface: "mcp" });
    }
  })().catch(() => undefined);
}
