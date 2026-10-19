// SPDX-License-Identifier: Apache-2.0
import type { McpServerEntry } from "./mcp-types.js";
import { joinHomePath } from "./mcp-installers/types.js";

/**
 * Pure functions that manipulate Claude Code's `claude_desktop_config.json`
 * document. Intended for a caller to wrap with real fs
 * reads/writes; kept pure here so a future test suite can exercise the
 * merge logic in isolation.
 */

/**
 * Returns the path of Claude Code's user-scoped config file. Note this
 * is `~/.claude.json` (Claude Code CLI / VSCode extension) — *not*
 * `~/.claude/claude_desktop_config.json`, which belongs to the separate
 * Claude Desktop app.
 */
export function defaultClaudeConfigPath(
  platform: NodeJS.Platform,
  home: string,
  _appData?: string,
): string {
  // Claude Code uses the same relative path on every platform; only the
  // separator differs between Windows and POSIX hosts.
  return joinHomePath(platform, home, ".claude.json");
}

/** Name of the MCP server entry we manage. */
export const PATHRULE_SERVER_KEY = "pathrule";

interface ConfigShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** Type-narrows arbitrary JSON to a config-shaped object; throws on malformed input. */
function asConfigObject(raw: unknown): ConfigShape {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Claude config root must be a JSON object");
  }
  const obj = raw as ConfigShape;
  if (obj.mcpServers !== undefined) {
    if (
      typeof obj.mcpServers !== "object" ||
      obj.mcpServers === null ||
      Array.isArray(obj.mcpServers)
    ) {
      throw new Error("Claude config `mcpServers` must be an object");
    }
  }
  return obj;
}

/** Merge the pathrule entry into `existing`, preserving all other keys. */
export function injectPathrule(
  existing: unknown,
  entry: McpServerEntry,
): { config: Record<string, unknown>; wasNew: boolean } {
  const config = asConfigObject(existing);
  const mcpServers = { ...(config.mcpServers ?? {}) };
  const wasNew = !(PATHRULE_SERVER_KEY in mcpServers);
  mcpServers[PATHRULE_SERVER_KEY] = entry;
  return {
    config: { ...config, mcpServers } as Record<string, unknown>,
    wasNew,
  };
}

/** Remove the pathrule entry from `existing`, keeping all other servers. */
export function removePathrule(existing: unknown): {
  config: Record<string, unknown>;
  wasPresent: boolean;
} {
  const config = asConfigObject(existing);
  if (!config.mcpServers || !(PATHRULE_SERVER_KEY in config.mcpServers)) {
    return { config: config as Record<string, unknown>, wasPresent: false };
  }
  const { [PATHRULE_SERVER_KEY]: _removed, ...rest } = config.mcpServers;
  void _removed;
  return {
    config: { ...config, mcpServers: rest } as Record<string, unknown>,
    wasPresent: true,
  };
}

/** Inspect a parsed config and return the current pathrule entry, or null. */
export function readPathruleEntry(existing: unknown): McpServerEntry | null {
  try {
    const config = asConfigObject(existing);
    const entry = config.mcpServers?.[PATHRULE_SERVER_KEY];
    return entry ?? null;
  } catch {
    return null;
  }
}
