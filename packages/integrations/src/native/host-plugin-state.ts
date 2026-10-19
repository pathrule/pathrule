// SPDX-License-Identifier: Apache-2.0
/**
 * What an agent host says about the Pathrule plugin it installed: the version on disk, the
 * marketplace it came from, whether the host updates it by itself, and the launcher config the
 * plugin carries. Read only: Pathrule never edits a host's plugin state, it tells the person which
 * host command updates the plugin.
 *
 * - **Claude Code** (`~/.claude`, or `CLAUDE_CONFIG_DIR`): `plugins/installed_plugins.json` lists
 *   each install with its version; `plugins/known_marketplaces.json` names each marketplace's
 *   source and the auto-update toggle. Auto-update follows the host's precedence: the marketplace's
 *   `autoUpdate` in settings (`extraKnownMarketplaces`), then in `known_marketplaces.json`, then the
 *   default, which is off for a third-party marketplace such as Pathrule's. `DISABLE_AUTOUPDATER`,
 *   `DISABLE_UPDATES` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` stop it unless
 *   `FORCE_AUTOUPDATE_PLUGINS` is set.
 * - **Codex** (`~/.codex`, or `CODEX_HOME`): a plugin lives in
 *   `plugins/cache/<marketplace>/<plugin>/<version>/`. Codex refreshes a marketplace only on
 *   `codex plugin marketplace upgrade`, so it never updates the plugin by itself.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { compareVersions } from "@pathrule/protocol/release-manifest.js";
import { parse as parseToml } from "smol-toml";

import { integrationsDir } from "./home.js";

export const PATHRULE_PLUGIN_NAME = "pathrule";

export type MarketplaceSource = "github" | "git" | "directory" | "url" | "unknown";

export interface PluginLauncherConfig {
  version: string | null;
  minRuntime: string | null;
  launcherContract: number | null;
}

export interface HostPluginState {
  host: "claude-code" | "codex";
  installed: boolean;
  /** `pathrule@<marketplace>`. */
  id: string | null;
  version: string | null;
  installPath: string | null;
  marketplace: { name: string; source: MarketplaceSource; location: string | null } | null;
  /** Whether the host updates the plugin by itself; null when it cannot be told. */
  autoUpdate: boolean | null;
  /** Why `autoUpdate` is what it is, in a few words. */
  autoUpdateReason: string;
  launcher: PluginLauncherConfig | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const CONFIG = /\/\*@pathrule-plugin-config\*\/([\s\S]*?)\/\*@end-pathrule-plugin-config\*\//;

/** The launcher config a plugin bakes into its scripts, or null. */
export function readPluginLauncherConfig(installPath: string): PluginLauncherConfig | null {
  for (const name of ["pathrule-launch", "pathrule-launch.cjs"]) {
    let source: string;
    try {
      source = readFileSync(join(installPath, "scripts", name), "utf8");
    } catch {
      continue;
    }
    const match = CONFIG.exec(source);
    if (!match) continue;
    try {
      const config = JSON.parse(match[1]!.trim()) as Record<string, unknown>;
      return {
        version: typeof config.version === "string" ? config.version : null,
        minRuntime: typeof config.minRuntime === "string" ? config.minRuntime : null,
        launcherContract:
          typeof config.launcherContract === "number" ? config.launcherContract : null,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function sourceOf(raw: unknown): { source: MarketplaceSource; location: string | null } {
  const s = (raw ?? {}) as { source?: unknown; repo?: unknown; path?: unknown; url?: unknown };
  switch (s.source) {
    case "github":
      return { source: "github", location: typeof s.repo === "string" ? s.repo : null };
    case "git":
      return { source: "git", location: typeof s.url === "string" ? s.url : null };
    case "directory":
      return { source: "directory", location: typeof s.path === "string" ? s.path : null };
    case "url":
      return { source: "url", location: typeof s.url === "string" ? s.url : null };
    default:
      return { source: "unknown", location: null };
  }
}

const TRUTHY = (value: unknown) => value === "1" || value === "true" || value === true;

export interface HostStateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** The person's home: the given one, then the environment's, then the OS's. */
function homeOf(options: HostStateOptions): string {
  const env = options.env ?? process.env;
  return options.home ?? (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir());
}

export function claudeConfigDir(options: HostStateOptions = {}): string {
  const env = options.env ?? process.env;
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homeOf(options), ".claude");
}

export function readClaudeCodePluginState(options: HostStateOptions = {}): HostPluginState {
  const env = options.env ?? process.env;
  const dir = claudeConfigDir(options);
  const pluginsDir = env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim() || join(dir, "plugins");
  const empty: HostPluginState = {
    host: "claude-code",
    installed: false,
    id: null,
    version: null,
    installPath: null,
    marketplace: null,
    autoUpdate: null,
    autoUpdateReason: "not installed",
    launcher: null,
  };
  const installed = readJson(join(pluginsDir, "installed_plugins.json")) as {
    plugins?: Record<string, Array<{ version?: unknown; installPath?: unknown; scope?: unknown }>>;
  } | null;
  const id = Object.keys(installed?.plugins ?? {}).find((key) =>
    key.startsWith(`${PATHRULE_PLUGIN_NAME}@`),
  );
  if (!id) return empty;
  const entries = installed!.plugins![id] ?? [];
  // A user-scope install is the one every project gets; otherwise the newest of the others.
  const entry =
    entries.find((e) => e.scope === "user") ??
    [...entries].sort((a, b) => compareVersions(String(b.version), String(a.version)) ?? 0)[0];
  const marketplaceName = id.slice(PATHRULE_PLUGIN_NAME.length + 1);
  const known = readJson(join(pluginsDir, "known_marketplaces.json")) as Record<
    string,
    { source?: unknown; autoUpdate?: unknown }
  > | null;
  const settings = readJson(join(dir, "settings.json")) as {
    extraKnownMarketplaces?: Record<string, { autoUpdate?: unknown }>;
    env?: Record<string, unknown>;
  } | null;

  const hostEnv = { ...(settings?.env ?? {}), ...env } as Record<string, unknown>;
  let autoUpdate: boolean;
  let autoUpdateReason: string;
  const fromSettings = settings?.extraKnownMarketplaces?.[marketplaceName]?.autoUpdate;
  const fromKnown = known?.[marketplaceName]?.autoUpdate;
  if (typeof fromSettings === "boolean") {
    autoUpdate = fromSettings;
    autoUpdateReason = "set in Claude Code settings";
  } else if (typeof fromKnown === "boolean") {
    autoUpdate = fromKnown;
    autoUpdateReason = "set in /plugin, Marketplaces";
  } else {
    autoUpdate = false;
    autoUpdateReason = "off by default for this marketplace";
  }
  if (
    autoUpdate &&
    !TRUTHY(hostEnv.FORCE_AUTOUPDATE_PLUGINS) &&
    (TRUTHY(hostEnv.DISABLE_AUTOUPDATER) ||
      TRUTHY(hostEnv.DISABLE_UPDATES) ||
      hostEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined)
  ) {
    autoUpdate = false;
    autoUpdateReason = "turned off by Claude Code's update settings";
  }

  const installPath = typeof entry?.installPath === "string" ? entry.installPath : null;
  return {
    host: "claude-code",
    installed: true,
    id,
    version: typeof entry?.version === "string" ? entry.version : null,
    installPath,
    marketplace: { name: marketplaceName, ...sourceOf(known?.[marketplaceName]?.source) },
    autoUpdate,
    autoUpdateReason,
    launcher: installPath ? readPluginLauncherConfig(installPath) : null,
  };
}

export function codexHome(options: HostStateOptions = {}): string {
  const env = options.env ?? process.env;
  return env.CODEX_HOME?.trim() || join(homeOf(options), ".codex");
}

/** Codex's `[marketplaces.<name>]` table: `source_type` "local" or "git", and its source. */
function codexMarketplace(options: HostStateOptions, name: string): HostPluginState["marketplace"] {
  try {
    const config = parseToml(readFileSync(join(codexHome(options), "config.toml"), "utf8")) as {
      marketplaces?: Record<string, { source_type?: unknown; source?: unknown }>;
    };
    const entry = config.marketplaces?.[name];
    const location = typeof entry?.source === "string" ? entry.source : null;
    const source: MarketplaceSource =
      entry?.source_type === "git"
        ? "git"
        : entry?.source_type === "local"
          ? "directory"
          : "unknown";
    return { name, source, location };
  } catch {
    return { name, source: "unknown", location: null };
  }
}

export function readCodexPluginState(options: HostStateOptions = {}): HostPluginState {
  const cache = join(codexHome(options), "plugins", "cache");
  const empty: HostPluginState = {
    host: "codex",
    installed: false,
    id: null,
    version: null,
    installPath: null,
    marketplace: null,
    autoUpdate: false,
    autoUpdateReason: "Codex updates plugins only on request",
    launcher: null,
  };
  let marketplaces: string[];
  try {
    marketplaces = readdirSync(cache);
  } catch {
    return empty;
  }
  for (const marketplace of marketplaces) {
    const dir = join(cache, marketplace, PATHRULE_PLUGIN_NAME);
    if (!existsSync(dir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(dir).filter((v) => compareVersions(v, v) !== null);
    } catch {
      continue;
    }
    const version = versions.sort((a, b) => compareVersions(b, a) ?? 0)[0];
    if (!version) continue;
    const installPath = join(dir, version);
    return {
      host: "codex",
      installed: true,
      id: `${PATHRULE_PLUGIN_NAME}@${marketplace}`,
      version,
      installPath,
      marketplace: codexMarketplace(options, marketplace),
      autoUpdate: false,
      autoUpdateReason: "Codex updates plugins only on request",
      launcher: readPluginLauncherConfig(installPath),
    };
  }
  return empty;
}

/**
 * The host commands that update the Pathrule plugin, in order (each one must succeed before the
 * next). A marketplace `pathrule integrations` wrote on this machine is rewritten by this CLI
 * first. Codex refreshes only Git marketplaces (`marketplace upgrade`); a local one is read again
 * by `plugin add`.
 */
export function pluginUpdateCommands(
  state: HostPluginState,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const marketplace = state.marketplace?.name ?? PATHRULE_PLUGIN_NAME;
  const id = state.id ?? `${PATHRULE_PLUGIN_NAME}@${marketplace}`;
  const ownedByPathrule =
    state.marketplace?.source === "directory" &&
    state.marketplace.location !== null &&
    samePath(state.marketplace.location, join(integrationsDir(env), "marketplace"));
  const refresh = ownedByPathrule ? ["pathrule integrations repair"] : [];
  if (state.host === "claude-code") {
    return [
      ...refresh,
      `claude plugin marketplace update ${marketplace}`,
      `claude plugin update ${id}`,
    ];
  }
  return state.marketplace?.source === "git"
    ? [...refresh, `codex plugin marketplace upgrade ${marketplace}`, `codex plugin add ${id}`]
    : [...refresh, `codex plugin add ${id}`];
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** How a new plugin version starts running in the host. */
export function pluginActivation(state: HostPluginState): string {
  return state.host === "claude-code"
    ? "It takes effect after /reload-plugins or in a new session."
    : "It takes effect in a new Codex session.";
}
