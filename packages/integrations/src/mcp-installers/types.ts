// SPDX-License-Identifier: Apache-2.0
// Pure-function contract for adding/removing/reading the Pathrule MCP entry
// in any AI client's config file. Each installer implements this for its
// specific format (JSON, TOML) + path layout. The caller that applies it
// does the fs I/O.
//
// Browser-safe by construction: no fs/path/os imports. Path resolution takes
// `homedir` + `platform` as parameters so callers can stay deterministic in
// tests and reuse the same code from the renderer if ever needed.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import type { McpServerEntry } from "../mcp-types.js";

/** Name we register the entry under across every client config. */
export const PATHRULE_SERVER_KEY = "pathrule";

/**
 * Cross-platform path joiner for installer config files. We can't use
 * `node:path` here because the contract above is "browser-safe by
 * construction: no fs/path/os imports". The function is intentionally
 * minimal — it only joins absolute home dirs with simple segments and
 * normalizes the slash to whatever the target platform expects.
 *
 * Examples:
 *   joinHomePath("win32", "C:\\Users\\Bob", ".codex", "config.toml")
 *     → "C:\\Users\\Bob\\.codex\\config.toml"
 *   joinHomePath("darwin", "/Users/bob", ".cursor", "mcp.json")
 *     → "/Users/bob/.cursor/mcp.json"
 */
export function joinHomePath(
  platform: NodeJS.Platform,
  homedir: string,
  ...segments: string[]
): string {
  const sep = platform === "win32" ? "\\" : "/";
  // Strip a trailing separator from the home dir so we never produce
  // double-separators on the join boundary.
  const trimmedHome = homedir.replace(/[\\/]+$/, "");
  const cleanedSegments = segments.map((s) => s.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [trimmedHome, ...cleanedSegments].join(sep);
}

/**
 * Read-side detail API exposed by every installer so doctor/repair can
 * validate the managed launch target without having to re-parse the
 * client-specific config format.
 */
export interface ManagedMcpEntryInfo {
  /** True when our entry exists in the parsed config. */
  present: boolean;
  /** The parsed entry, or null when not present / config unparseable. */
  entry: McpServerEntry | null;
  /** Resolved launch command (often `process.execPath`), or null when unknown. */
  launchCommand: string | null;
  /** Resolved launch args array (empty when not present). */
  launchArgs: string[];
  /**
   * When the entry is present but launch target is unsafe to keep around.
   * `repair` should rewrite the entry; `doctor` should warn.
   */
  staleReason?: "missing-file" | "repo-relative-mcp-server" | "unknown-command";
}

export interface ClientInstaller {
  /** Stable id matching AgentTargetId. */
  readonly id: AgentTargetId;
  /**
   * Human label disambiguating this config when a client registers more than
   * one installer (copilot: "Copilot CLI" vs "VS Code user config"). Leave
   * unset for single-config clients — display surfaces fall back to the id.
   */
  readonly configLabel?: string;
  /** Absolute config path on the user's machine. */
  homeConfigPath(homedir: string, platform: NodeJS.Platform): string;
  /**
   * Merge the Pathrule entry into the existing file body. `existing === null`
   * means the file doesn't exist yet — installer must return a body that's
   * safe to write as the very first content.
   */
  inject(existing: string | null, entry: McpServerEntry): InjectResult;
  /**
   * Strip the Pathrule entry. Returns `body: null` when the resulting
   * document is effectively empty (caller should delete the file or write a
   * minimal stub — installer choice).
   */
  remove(existing: string | null): RemoveResult;
  /** Read the current entry, or null if not installed/parsable. */
  read(existing: string | null): McpServerEntry | null;
  /**
   * Detail-API for doctor/repair: parse the file, return the managed entry
   * along with the resolved launch target and an optional `staleReason`
   * when the entry exists but its launch target is broken (missing file,
   * repo-relative MCP path, etc.). Default implementation lives at
   * `defaultManagedEntryInfo()` — installers override only when they need
   * format-specific staleness detection.
   */
  getManagedEntry(existing: string | null): ManagedMcpEntryInfo;
}

export interface InjectResult {
  /** Serialised config body ready to write. */
  body: string;
  /** True when our entry was newly added; false when an entry already existed and was overwritten. */
  wasNew: boolean;
}

export interface RemoveResult {
  /** Serialised body, or null if the file should be removed entirely. */
  body: string | null;
  /** True when an entry was found and removed. */
  wasPresent: boolean;
}

/**
 * Shared `getManagedEntry` implementation. Most installers can reuse this
 * directly via their existing `read` function; the staleness check looks at
 * the resolved launch target and flags the known failure modes.
 */
export function defaultManagedEntryInfo(
  read: (existing: string | null) => McpServerEntry | null,
  existing: string | null,
): ManagedMcpEntryInfo {
  const entry = read(existing);
  if (!entry) {
    return { present: false, entry: null, launchCommand: null, launchArgs: [] };
  }
  const launchCommand = entry.command ?? null;
  const launchArgs = Array.isArray(entry.args) ? entry.args.slice() : [];
  const info: ManagedMcpEntryInfo = {
    present: true,
    entry,
    launchCommand,
    launchArgs,
  };
  // Repo-relative MCP server path was a known blocker: an old `pathrule install`
  // wrote `args[0]` pointing at `<...>/packages/mcp-server/dist/index.js`,
  // which does not exist after a clean npm install. Studio's development build
  // writes the same kind of entry, now under packages/app.
  if (
    launchArgs.some(
      (arg) =>
        arg.includes("packages/mcp-server/dist/index.js") ||
        arg.includes("packages/app/mcp-server/dist/index.js"),
    )
  ) {
    info.staleReason = "repo-relative-mcp-server";
    return info;
  }
  if (!launchCommand) {
    info.staleReason = "unknown-command";
  }
  return info;
}
