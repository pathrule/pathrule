// SPDX-License-Identifier: Apache-2.0
// OpenAI Codex CLI MCP installer — writes to `~/.codex/config.toml`. TOML
// shape per the Codex config reference:
//
//   [mcp_servers.pathrule]
//   command = "node"
//   args = ["/abs/path/to/server.js"]
//   enabled = true
//
//   [mcp_servers.pathrule.env]
//   SOME_ENV_KEY = "…"   (whatever env the resolved entry carries)
//
// `type` is not part of the Codex schema — Codex only supports stdio servers
// in this section, so it would be redundant.

import { parse, stringify } from "smol-toml";

import type { McpServerEntry } from "../mcp-types.js";
import {
  PATHRULE_SERVER_KEY,
  defaultManagedEntryInfo,
  joinHomePath,
  type ClientInstaller,
  type InjectResult,
  type ManagedMcpEntryInfo,
  type RemoveResult,
} from "./types.js";

interface CodexConfig {
  mcp_servers?: Record<string, CodexEntry>;
  [key: string]: unknown;
}

interface CodexEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  required?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
}

const UTF8_BOM = "﻿";

interface ParseOutcome {
  config: CodexConfig;
  hadBom: boolean;
}

function parseExisting(existing: string | null): ParseOutcome {
  if (!existing || existing.trim().length === 0) return { config: {}, hadBom: false };
  const hadBom = existing.charCodeAt(0) === 0xfeff;
  const body = hadBom ? existing.slice(1) : existing;
  let parsed: unknown;
  try {
    parsed = parse(body);
  } catch (e) {
    throw new Error(`config.toml is not valid TOML: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.toml root must be a TOML table");
  }
  return { config: parsed as CodexConfig, hadBom };
}

function serializeWithBom(body: string, hadBom: boolean): string {
  return hadBom ? UTF8_BOM + body : body;
}

function entryToCodex(entry: McpServerEntry): CodexEntry {
  // Drop the `type` field — Codex doesn't surface it. Always mark `enabled`
  // explicitly so a freshly-injected server can be flipped off via Settings
  // without rewriting the section.
  const out: CodexEntry = {
    command: entry.command,
    args: entry.args,
    enabled: true,
  };
  if (entry.env && Object.keys(entry.env).length > 0) {
    out.env = entry.env;
  }
  return out;
}

function codexToEntry(raw: CodexEntry | undefined): McpServerEntry | null {
  if (!raw || typeof raw.command !== "string") return null;
  return {
    type: "stdio",
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : undefined,
  };
}

export const codexInstaller: ClientInstaller = {
  id: "codex",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    return joinHomePath(platform, homedir, ".codex", "config.toml");
  },
  inject(existing: string | null, entry: McpServerEntry): InjectResult {
    const { config, hadBom } = parseExisting(existing);
    const servers = { ...(config.mcp_servers ?? {}) };
    const wasNew = !(PATHRULE_SERVER_KEY in servers);
    servers[PATHRULE_SERVER_KEY] = entryToCodex(entry);
    const merged: CodexConfig = { ...config, mcp_servers: servers };
    return { body: serializeWithBom(stringify(merged) + "\n", hadBom), wasNew };
  },
  remove(existing: string | null): RemoveResult {
    const { config, hadBom } = parseExisting(existing);
    const servers = config.mcp_servers ?? {};
    if (!(PATHRULE_SERVER_KEY in servers)) {
      return { body: existing, wasPresent: false };
    }
    const { [PATHRULE_SERVER_KEY]: _omitted, ...rest } = servers;
    void _omitted;
    const next: CodexConfig = { ...config };
    if (Object.keys(rest).length === 0) {
      delete next.mcp_servers;
    } else {
      next.mcp_servers = rest;
    }
    if (Object.keys(next).length === 0) {
      return { body: null, wasPresent: true };
    }
    return { body: serializeWithBom(stringify(next) + "\n", hadBom), wasPresent: true };
  },
  read(existing: string | null): McpServerEntry | null {
    try {
      const { config } = parseExisting(existing);
      return codexToEntry(config.mcp_servers?.[PATHRULE_SERVER_KEY]);
    } catch {
      return null;
    }
  },
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo((body) => codexInstaller.read(body), existing);
  },
};
