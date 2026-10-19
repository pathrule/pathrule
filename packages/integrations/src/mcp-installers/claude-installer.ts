// SPDX-License-Identifier: Apache-2.0
// Claude Code MCP installer — wraps the existing claude-config helpers in
// the ClientInstaller shape so the orchestrator can treat Claude uniformly
// with the other three clients. Path is `~/.claude.json` on every platform.

import {
  defaultClaudeConfigPath,
  injectPathrule,
  readPathruleEntry,
  removePathrule,
} from "../claude-config.js";
import type { McpServerEntry } from "../mcp-types.js";
import {
  defaultManagedEntryInfo,
  type ClientInstaller,
  type InjectResult,
  type ManagedMcpEntryInfo,
  type RemoveResult,
} from "./types.js";

const UTF8_BOM = "﻿";

interface ParseOutcome {
  raw: unknown;
  hadBom: boolean;
}

function parseJson(existing: string | null): ParseOutcome {
  if (!existing || existing.trim().length === 0) return { raw: undefined, hadBom: false };
  const hadBom = existing.charCodeAt(0) === 0xfeff;
  const body = hadBom ? existing.slice(1) : existing;
  try {
    return { raw: JSON.parse(body), hadBom };
  } catch (e) {
    throw new Error(`Claude config is not valid JSON: ${(e as Error).message}`);
  }
}

function serialize(config: unknown, hadBom: boolean): string {
  const body = JSON.stringify(config, null, 2) + "\n";
  return hadBom ? UTF8_BOM + body : body;
}

export const claudeInstaller: ClientInstaller = {
  id: "claude-code",
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string {
    return defaultClaudeConfigPath(platform, homedir);
  },
  inject(existing: string | null, entry: McpServerEntry): InjectResult {
    const { raw, hadBom } = parseJson(existing);
    const { config, wasNew } = injectPathrule(raw ?? {}, entry);
    return { body: serialize(config, hadBom), wasNew };
  },
  remove(existing: string | null): RemoveResult {
    if (existing === null) return { body: null, wasPresent: false };
    const { raw, hadBom } = parseJson(existing);
    const { config, wasPresent } = removePathrule(raw);
    if (!wasPresent) return { body: existing, wasPresent: false };
    // Claude config holds many other top-level keys we MUST preserve. Never
    // delete the file even if mcpServers ends up empty — Claude's CLI relies
    // on other entries existing.
    return { body: serialize(config, hadBom), wasPresent: true };
  },
  read(existing: string | null): McpServerEntry | null {
    try {
      const { raw } = parseJson(existing);
      return readPathruleEntry(raw);
    } catch {
      return null;
    }
  },
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo {
    return defaultManagedEntryInfo((body) => claudeInstaller.read(body), existing);
  },
};
