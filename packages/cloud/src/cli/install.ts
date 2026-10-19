// SPDX-License-Identifier: Apache-2.0
// The MCP entries `pathrule setup` writes for a Pathrule Cloud folder. One entry serves every folder
// whatever its edition (the server resolves each call's folder), so Cloud writes the open CLI's entry
// (`installCliMcpTargets`) and adds only its lines and its exit rule.
import {
  installCliMcpTargets,
  resolveMcpServerEntry,
  type CliInstallResult,
} from "@pathrule/cli/install-local.js";
import { statusLabel, type CliOutputMode } from "@pathrule/cli/output.js";

/** The one MCP entry. Kept under its former name for the account edition's `mcpEntry`, unread. */
export const resolveCliMcpEntry = resolveMcpServerEntry;

/** `pathrule install`'s writer, under its former name. */
export const installCliTargets = installCliMcpTargets;

export interface SetupMcpOutcome {
  results: CliInstallResult[];
  /** A target the installer does not know; then nothing was written. */
  error: string | null;
  /** One line per client config, labelled as the local setup labels its own. */
  lines: string[];
  /** No client got its entry: setup then exits non-zero. One failing client is only a warning. */
  failed: boolean;
}

/** Writes the MCP entry into the AI clients `target` names (every client when null). */
export async function installSetupMcpEntries(
  target: string | null,
  env: NodeJS.ProcessEnv,
  mode: CliOutputMode,
): Promise<SetupMcpOutcome> {
  let results: CliInstallResult[];
  try {
    results = await installCliMcpTargets(target ?? undefined, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error =
      message === "invalid_install_target"
        ? `No MCP entry was written: --target ${target ?? ""} is not an AI client Pathrule knows (claude, cursor, codex, windsurf, copilot or all).`
        : `No MCP entry was written: ${message}`;
    return { results: [], error, lines: [`${statusLabel("warn", mode)} ${error}`], failed: true };
  }
  return {
    results,
    error: null,
    lines: results.map((r) =>
      r.ok
        ? `${statusLabel("ok", mode)} ${r.client}: MCP entry installed (${r.config_path})`
        : `${statusLabel("warn", mode)} ${r.client}: MCP entry not installed: ${r.error ?? "unknown error"} (${r.config_path})`,
    ),
    failed: results.length > 0 && results.every((r) => !r.ok),
  };
}
