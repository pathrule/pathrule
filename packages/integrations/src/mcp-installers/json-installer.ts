// SPDX-License-Identifier: Apache-2.0
// Generic `{ <rootKey>: { <name>: { ... } } }` JSON installer. Cursor and
// Windsurf speak the `mcpServers` shape — the only meaningful difference is
// whether the server entry carries an explicit `type: "stdio"` field. Cursor
// docs require it; Windsurf docs don't mention it, so we strip it there to
// avoid any future schema strictness surprises. Copilot reuses this with a
// different root key (VS Code's user `mcp.json` uses `servers`) and entry
// shape (`type: "local"` + a `tools` allowlist for the Copilot CLI).

import type { McpServerEntry } from "../mcp-types.js";
import { PATHRULE_SERVER_KEY, type InjectResult, type RemoveResult } from "./types.js";

interface ConfigShape {
  [key: string]: unknown;
}

function asConfigObject(raw: unknown, rootKey: string): ConfigShape {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config root must be a JSON object");
  }
  const obj = raw as ConfigShape;
  const servers = obj[rootKey];
  if (servers !== undefined) {
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
      throw new Error(`\`${rootKey}\` must be an object`);
    }
  }
  return obj;
}

// Preserve UTF-8 BOM round-trip. AI clients (notably Cursor on
// Windows when the file is created by certain text editors) sometimes
// write configs with a leading BOM. Rewriting without it can confuse
// strict parsers, so we detect and re-emit the BOM when it was present.
const UTF8_BOM = "﻿";

interface ParseOutcome {
  config: ConfigShape;
  hadBom: boolean;
}

function parseExisting(existing: string | null, rootKey: string): ParseOutcome {
  if (!existing || existing.trim().length === 0) {
    return { config: {}, hadBom: false };
  }
  const hadBom = existing.charCodeAt(0) === 0xfeff;
  const body = hadBom ? existing.slice(1) : existing;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`Config is not valid JSON: ${(e as Error).message}`);
  }
  return { config: asConfigObject(parsed, rootKey), hadBom };
}

function serialize(config: Record<string, unknown>, hadBom: boolean): string {
  const body = JSON.stringify(config, null, 2) + "\n";
  return hadBom ? UTF8_BOM + body : body;
}

export interface JsonInstallerOptions {
  /** When true, preserve the `type` field on the written entry. Cursor needs it; Windsurf doesn't. */
  includeTypeField: boolean;
  /** Root object key holding the server map. Defaults to "mcpServers"; VS Code's user `mcp.json` uses "servers". */
  rootKey?: string;
  /** Overrides the written entry's `type` value (Copilot CLI's schema uses "local"). Read-side is untouched. */
  typeFieldValue?: string;
  /** Extra fields merged into the written entry (e.g. Copilot CLI's `tools: ["*"]` allowlist). */
  entryExtras?: Record<string, unknown>;
}

export function makeJsonInstaller(options: JsonInstallerOptions) {
  const rootKey = options.rootKey ?? "mcpServers";

  function serversOf(config: ConfigShape): Record<string, McpServerEntry> {
    return (config[rootKey] as Record<string, McpServerEntry> | undefined) ?? {};
  }

  function shapeEntry(entry: McpServerEntry): McpServerEntry {
    const extras = options.entryExtras ?? {};
    if (!options.includeTypeField) {
      // Strip the `type` field for clients that don't surface it in their
      // public schema. Pathrule is always stdio, so no information is lost.
      const { type: _omitted, ...rest } = entry;
      void _omitted;
      return { ...rest, ...extras } as McpServerEntry;
    }
    return {
      ...entry,
      type: (options.typeFieldValue ?? entry.type) as McpServerEntry["type"],
      ...extras,
    };
  }

  return {
    inject(existing: string | null, entry: McpServerEntry): InjectResult {
      const { config, hadBom } = parseExisting(existing, rootKey);
      const next = { ...serversOf(config) };
      const wasNew = !(PATHRULE_SERVER_KEY in next);
      next[PATHRULE_SERVER_KEY] = shapeEntry(entry);
      const merged = { ...config, [rootKey]: next };
      return { body: serialize(merged, hadBom), wasNew };
    },
    remove(existing: string | null): RemoveResult {
      const { config, hadBom } = parseExisting(existing, rootKey);
      const servers = serversOf(config);
      if (!(PATHRULE_SERVER_KEY in servers)) {
        return { body: existing, wasPresent: false };
      }
      const { [PATHRULE_SERVER_KEY]: _removed, ...rest } = servers;
      void _removed;
      const next = { ...config, [rootKey]: rest };
      // If the file would now be `{ "<rootKey>": {} }` AND nothing else
      // is set, drop the file entirely so we don't litter user homes.
      const onlyEmptyServers =
        Object.keys(rest).length === 0 && Object.keys(next).length === 1 && rootKey in next;
      if (onlyEmptyServers) {
        return { body: null, wasPresent: true };
      }
      return { body: serialize(next, hadBom), wasPresent: true };
    },
    read(existing: string | null): McpServerEntry | null {
      try {
        const { config } = parseExisting(existing, rootKey);
        return serversOf(config)[PATHRULE_SERVER_KEY] ?? null;
      } catch {
        return null;
      }
    },
  };
}
