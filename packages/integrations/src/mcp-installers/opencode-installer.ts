// SPDX-License-Identifier: Apache-2.0
// OpenCode CLI MCP installer — writes to `~/.config/opencode/opencode.json`.
// OpenCode's config shape differs from the stdio entry the other clients use:
// `command` is a SINGLE array (binary + args), env lives under `environment`,
// and a server is gated by an explicit `enabled` flag. Per the OpenCode config
// reference (https://opencode.ai/docs/mcp-servers/):
//
//   {
//     "$schema": "https://opencode.ai/config.json",
//     "mcp": {
//       "pathrule": {
//         "type": "local",
//         "command": ["node", "/abs/path/to/server.js"],
//         "enabled": true,
//         "environment": { "SOME_ENV_KEY": "…" }
//       }
//     }
//   }
//
// OpenCode is a Studio ENGINE (AgentId), not a skills agent-target
// (AgentTargetId), so this installer is invoked from the engine-prep flow
// rather than the AgentTargetId INSTALLERS registry. That keeps OpenCode out of
// the skills/companion-file/gitignore machinery while still wiring the MCP in.
// The exported functions mirror the ClientInstaller contract so OpenCode can be
// promoted to a full agent-target later without reshaping this module.

import type { McpServerEntry } from "../mcp-types.js";
import {
  PATHRULE_SERVER_KEY,
  joinHomePath,
  type InjectResult,
  type RemoveResult,
} from "./types.js";

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

interface OpencodeMcpEntry {
  type?: "local" | "remote";
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  url?: string;
  [key: string]: unknown;
}

interface OpencodeConfig {
  $schema?: string;
  mcp?: Record<string, OpencodeMcpEntry>;
  [key: string]: unknown;
}

/** Absolute path to OpenCode's global config on this machine. */
export function opencodeHomeConfigPath(homedir: string, platform: NodeJS.Platform): string {
  return joinHomePath(platform, homedir, ".config", "opencode", "opencode.json");
}

function parseExisting(existing: string | null): OpencodeConfig {
  if (!existing || existing.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (e) {
    throw new Error(`opencode.json is not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("opencode.json root must be a JSON object");
  }
  return parsed as OpencodeConfig;
}

function entryToOpencode(entry: McpServerEntry): OpencodeMcpEntry {
  // OpenCode flattens command + args into one array and reads env from
  // `environment`. Always set `enabled` explicitly so the server can be flipped
  // off later without dropping the block.
  const out: OpencodeMcpEntry = {
    type: "local",
    command: [entry.command, ...entry.args],
    enabled: true,
  };
  if (entry.env && Object.keys(entry.env).length > 0) {
    out.environment = entry.env;
  }
  return out;
}

function opencodeToEntry(raw: OpencodeMcpEntry | undefined): McpServerEntry | null {
  if (!raw || !Array.isArray(raw.command) || raw.command.length === 0) return null;
  const parts = raw.command.map(String);
  return {
    type: "stdio",
    command: parts[0]!,
    args: parts.slice(1),
    env:
      raw.environment && typeof raw.environment === "object" && !Array.isArray(raw.environment)
        ? raw.environment
        : undefined,
  };
}

function serialize(config: OpencodeConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

export function injectOpencode(existing: string | null, entry: McpServerEntry): InjectResult {
  const config = parseExisting(existing);
  const mcp = { ...(config.mcp ?? {}) };
  const wasNew = !(PATHRULE_SERVER_KEY in mcp);
  mcp[PATHRULE_SERVER_KEY] = entryToOpencode(entry);
  // Spread config AFTER the default so an existing $schema/key set is preserved;
  // the default only fills a fresh file.
  const merged: OpencodeConfig = { $schema: OPENCODE_SCHEMA, ...config, mcp };
  return { body: serialize(merged), wasNew };
}

export function removeOpencode(existing: string | null): RemoveResult {
  const config = parseExisting(existing);
  const mcp = config.mcp ?? {};
  if (!(PATHRULE_SERVER_KEY in mcp)) {
    return { body: existing, wasPresent: false };
  }
  const { [PATHRULE_SERVER_KEY]: _omitted, ...rest } = mcp;
  void _omitted;
  const next: OpencodeConfig = { ...config };
  if (Object.keys(rest).length === 0) {
    delete next.mcp;
  } else {
    next.mcp = rest;
  }
  // A lone `$schema` is not meaningful content on its own.
  const meaningful = Object.keys(next).filter((k) => k !== "$schema");
  if (meaningful.length === 0) {
    return { body: null, wasPresent: true };
  }
  return { body: serialize(next), wasPresent: true };
}

export function readOpencode(existing: string | null): McpServerEntry | null {
  try {
    return opencodeToEntry(parseExisting(existing).mcp?.[PATHRULE_SERVER_KEY]);
  } catch {
    return null;
  }
}
