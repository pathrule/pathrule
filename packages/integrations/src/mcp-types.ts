// SPDX-License-Identifier: Apache-2.0
// The Pathrule MCP entry an AI client's config carries, and the install and status shapes
// the installers report.

export type McpServerStatus =
  | "not-installed" // at least one AI client has a config but none holds a Pathrule entry
  | "installed" // at least one AI client has a valid Pathrule entry
  | "config-missing" // no AI client config exists on this machine yet
  | "error";

export interface McpServerEntry {
  /** stdio for spawn-based local servers; http for remote. Same shape across all four clients. */
  type: "stdio" | "http";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Aggregated MCP status snapshot across all supported AI clients
 * (Claude Code, Cursor, Codex, Windsurf). Used by the TopBar chip and
 * any UI that needs a single yes/no answer to "is Pathrule wired in
 * anywhere on this machine?". Per-client detail lives in {@link ClientStatus}.
 */
export interface McpStatusSnapshot {
  status: McpServerStatus;
  configPath: string;
  serverCommand: string | null;
  serverArgs: string[] | null;
  error?: string;
}

/** Result of installing/sweeping/uninstalling the Pathrule MCP entry
 *  in a single AI client's home config. */
export interface ClientInstallResult {
  client: string;
  ok: boolean;
  status: "installed" | "removed" | "skipped" | "error";
  configPath: string;
  wasNew?: boolean;
  wasPresent?: boolean;
  error?: string;
}

/** Per-client status snapshot used by Settings UI / tray menu. */
export interface ClientStatus {
  client: string;
  configPath: string;
  configExists: boolean;
  installed: boolean;
  serverCommand: string | null;
  serverArgs: string[] | null;
  error?: string;
}

/** Workspace-scoped status used by Settings → AI Tools.
 *  `active` reflects whether THIS workspace is currently wired to the
 *  client (selection or disk markers); machine-level fields are for UI
 *  tooltip context only. */
export interface WorkspaceClientStatus {
  client: string;
  active: boolean;
  selected: boolean;
  markers: string[];
  machineInstalled: boolean;
  machineConfigPath: string;
  machineConfigExists: boolean;
  managedOwner?: "desktop" | "cli" | "mcp";
  managedOwnerVersion?: string;
  managedOwnershipStatus?: "current" | "other_owner" | "newer_version" | "older_version";
}
