// SPDX-License-Identifier: Apache-2.0
// The MCP installer: write, and remove, the Pathrule entry in every AI client's config. The entry
// the local edition writes is built here; an account edition supplies its own.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { getInstallers } from "@pathrule/integrations/mcp-installers/registry.js";
import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import type { McpServerEntry } from "@pathrule/integrations/mcp-types.js";
import { atomicWrite, readIfExists } from "@pathrule/core/storage/atomic-write.js";

import { cliPlatform } from "./platform.js";

export type CliInstallTarget = AgentTargetId | "all";

export interface CliInstallResult {
  client: AgentTargetId;
  ok: boolean;
  status: "installed" | "removed" | "not_present" | "error";
  config_path: string;
  was_new?: boolean;
  error?: string;
}

const TARGET_ALIASES: Record<string, CliInstallTarget> = {
  all: "all",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  windsurf: "windsurf",
  copilot: "copilot",
  "github-copilot": "copilot",
};

const ALL_TARGETS: AgentTargetId[] = ["claude-code", "cursor", "codex", "windsurf", "copilot"];

export function parseInstallTargets(raw: string | undefined): AgentTargetId[] {
  const target = TARGET_ALIASES[(raw ?? "all").toLowerCase()];
  if (!target) {
    throw new Error("invalid_install_target");
  }
  return target === "all" ? ALL_TARGETS : [target];
}

/** Install the Pathrule MCP entry (`resolveMcpServerEntry`) into AI-client configs. */
export async function installLocalCliTargets(
  rawTarget: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CliInstallResult[]> {
  const targets = parseInstallTargets(rawTarget);
  return installEntryToCliTargets(targets, resolveMcpServerEntry(env), env);
}

/**
 * `pathrule install`: the one entry every folder uses, whatever its edition. Targets are parsed
 * first, so an invalid one surfaces as `invalid_install_target` (EX_USAGE).
 */
export async function installCliMcpTargets(
  rawTarget: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CliInstallResult[]> {
  const targets = parseInstallTargets(rawTarget);
  return installEntryToCliTargets(targets, resolveMcpServerEntry(env), env);
}

/**
 * The home the AI clients' configs live under: the runtime's HOME, so a run given another home (an
 * integration host, a test) writes there and never into the person's own configs.
 */
function configHome(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.trim() !== "" ? env.HOME : homedir();
}

export async function uninstallCliTargets(
  rawTarget: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliInstallResult[]> {
  const platform = cliPlatform(env);
  // One result per (target, config file) — mirrors installEntryToCliTargets.
  return Promise.all(
    parseInstallTargets(rawTarget).flatMap((target) =>
      getInstallers(target).map(async (installer): Promise<CliInstallResult> => {
        const configPath = installer.homeConfigPath(configHome(env), platform);
        try {
          const existing = await readIfExists(configPath);
          const result = installer.remove(existing);
          if (!result.wasPresent) {
            return {
              client: target,
              ok: true,
              status: "not_present" as const,
              config_path: configPath,
            };
          }
          if (result.body === null) {
            await rm(configPath, { force: true });
          } else {
            await atomicWrite(configPath, result.body);
          }
          return {
            client: target,
            ok: true,
            status: "removed" as const,
            config_path: configPath,
          };
        } catch (err) {
          return {
            client: target,
            ok: false,
            status: "error" as const,
            config_path: configPath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    ),
  );
}

export async function installEntryToCliTargets(
  targets: AgentTargetId[],
  entry: McpServerEntry,
  env: NodeJS.ProcessEnv,
): Promise<CliInstallResult[]> {
  const platform = cliPlatform(env);
  // One result per (target, config file) — multi-config clients (copilot:
  // CLI config + VS Code user mcp.json) report each config separately.
  const results = await Promise.all(
    targets.flatMap((target) =>
      getInstallers(target).map(async (installer): Promise<CliInstallResult> => {
        const configPath = installer.homeConfigPath(configHome(env), platform);
        try {
          const existing = await readIfExists(configPath);
          const result = installer.inject(existing, entry);
          await atomicWrite(configPath, result.body);
          return {
            client: target,
            ok: true,
            status: "installed" as const,
            config_path: configPath,
            was_new: result.wasNew,
          };
        } catch (err) {
          return {
            client: target,
            ok: false,
            status: "error" as const,
            config_path: configPath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    ),
  );
  return results;
}

/**
 * The MCP entry written into every AI client: a deterministic launch (`process.execPath` + bundled
 * CLI + `mcp run`) that names no edition. The server resolves each call's folder, so one entry serves
 * a Local folder from its Local store and a Cloud folder from Pathrule Cloud, and a folder that changes
 * edition needs no new entry. No credentials are written: the server finds the session on this machine.
 */
export function resolveMcpServerEntry(env: NodeJS.ProcessEnv): McpServerEntry {
  const entry: McpServerEntry = {
    type: "stdio",
    command: process.execPath,
    args: [resolveCliEntrypoint(), "mcp", "run"],
    env: {},
  };
  applyPassthroughEnv(entry, env);
  return entry;
}

/** @deprecated The entry names no edition any more: `resolveMcpServerEntry`. */
export const resolveLocalCliMcpEntry = resolveMcpServerEntry;

// Only forward env values that are actually present — empty strings can
// mask defaults inside the spawned process. A Cloud named for this run (staging, a test) travels
// with the entry; the build's own Cloud needs nothing.
const MCP_ENTRY_ENV_PASSTHROUGH = [
  "PATHRULE_HOME",
  "PATHRULE_NATIVE_CLOUD_URL",
  "PATHRULE_NATIVE_DEVICE_CLIENT_ID",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function applyPassthroughEnv(entry: McpServerEntry, env: NodeJS.ProcessEnv): void {
  for (const key of MCP_ENTRY_ENV_PASSTHROUGH) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      entry.env![key] = value;
    }
  }
}

export function resolveCliEntrypoint(): string {
  // The binary is dist/index.js, beside this module. In the npm package each source file is its own
  // module in dist/; in a single-file bundle this module is dist/index.js itself. The result is an
  // absolute filesystem path, because Windows clients in particular cannot launch a `file://` URL or
  // a relative path. Run from source (tests, `tsx`), the module is a .ts file and is returned as is.
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts") ? here : fileURLToPath(new URL("./index.js", import.meta.url));
}
