// SPDX-License-Identifier: Apache-2.0
// Resolves which AI client is calling this MCP server. Two signal sources:
//
//   1. MCP transport handshake `client_info.name` (populated post-init by
//      the SDK; `Server.getClientVersion()` is the canonical accessor). Most
//      modern clients send a recognisable name here.
//   2. `MCP_CLIENT_NAME` env var. The OpenAI Codex CLI sets this; we honour
//      it as a fallback when the transport handshake didn't yield anything
//      we recognise.
//
// The resolved id flows into the per-call ToolContext so telemetry tools
// (`pathrule_log_activity`, `pathrule_get_refresh_brief`) can stamp the
// originating client server-side without each LLM having to remember the
// `ai_client` argument.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

/** Just enough of the MCP SDK Server's surface to pull the client name. */
interface ClientIdentitySource {
  getClientVersion(): { name?: string } | undefined;
}

let source: ClientIdentitySource | null = null;

/**
 * Called once from `server.ts` right after the MCP server is created so
 * `resolveClientId()` can read the transport handshake on every tool call.
 */
export function bindClientIdentitySource(s: ClientIdentitySource): void {
  source = s;
}

/**
 * Map a raw client name onto our agent-target enum. Permissive: matches on
 * substring (case-insensitive), strips whitespace + dashes, so cosmetic
 * variants like "Claude Code", "claude-code", "claude-ai" all converge.
 */
function normalise(raw: string): AgentTargetId | null {
  const lower = raw.toLowerCase();
  if (lower.includes("claude")) return "claude-code";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("codex")) return "codex";
  // Matches "GitHub Copilot" and "copilot-cli". VS Code itself handshakes as
  // "Visual Studio Code" — its only MCP consumer is Copilot agent mode, and
  // the fork names (Cursor/Windsurf) are matched above, so the bare editor
  // name maps to copilot too.
  if (lower.includes("copilot") || lower.includes("visual studio code")) return "copilot";
  return null;
}

/**
 * Resolve the calling client id. Returns null when neither the MCP
 * handshake nor the env var produces a recognisable name — callers default
 * to `claude-code` in that case to preserve backwards-compatible behaviour
 * (the original sole supported client).
 */
export function resolveClientId(): AgentTargetId | null {
  const candidates = [
    source?.getClientVersion()?.name,
    process.env["MCP_CLIENT_NAME"],
    process.env["PATHRULE_MCP_CLIENT"],
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const raw of candidates) {
    const id = normalise(raw);
    if (id) return id;
  }
  return null;
}
