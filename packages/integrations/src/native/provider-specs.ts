// SPDX-License-Identifier: Apache-2.0
// What the integration engine needs to know about each agent with a Pathrule plugin: its name, its
// command, the files a Local setup writes into the project, and whether Pathrule can install the
// plugin for the person through the agent's own command or only tell them how.

import { join } from "node:path";

import type { IntegrationProviderId, IntegrationScope } from "@pathrule/protocol/integration-registry.js";

const PLUGIN_ID = "pathrule@pathrule";

/** The provider plugin scope for a Pathrule scope: a project install of a local marketplace stays personal. */
function claudeScope(scope: IntegrationScope): "user" | "local" {
  return scope === "user" ? "user" : "local";
}

/** The agent's own commands that install and remove Pathrule's plugin from the local marketplace. */
export interface ProviderInstallCommands {
  /** Registers the marketplace at `dir`; null when the agent installs from a path directly. */
  marketplaceAdd: ((dir: string) => string[]) | null;
  marketplaceRemove: (() => string[]) | null;
  pluginInstall(scope: IntegrationScope, dir: string): string[];
  /** Null when the agent has no remove command: the person removes the plugin from its config. */
  pluginRemove: ((scope: IntegrationScope) => string[]) | null;
}

export interface NativeProviderSpec {
  label: string;
  /** The agent's command on PATH. */
  binary: string;
  /** What a Local workspace setup writes into the project for this agent, named in the plan. */
  projectFiles: string;
  /**
   * How `pathrule integrations` installs the plugin through the agent's own command; null for an
   * agent whose plugin install is interactive only, which gets the steps instead (`manual`).
   */
  install: ProviderInstallCommands | null;
  /** The steps a person follows to install the plugin from the marketplace at `dir`. */
  manual(dir: string): string[];
  /** What to do after setup for the plugin to load. */
  nextSession: string;
  /** Whether Pathrule writes hook entries into this agent's settings (the legacy channel). */
  settingsHooks: boolean;
}

export const NATIVE_PROVIDER_SPECS: Record<IntegrationProviderId, NativeProviderSpec> = {
  "claude-code": {
    label: "Claude Code",
    binary: "claude",
    projectFiles: "`.pathrule/` and `.claude/rules/pathrule/`",
    install: {
      marketplaceAdd: (dir) => ["plugin", "marketplace", "add", dir, "--scope", "user", "--json"],
      marketplaceRemove: () => ["plugin", "marketplace", "remove", "pathrule"],
      pluginInstall: (scope) => ["plugin", "install", PLUGIN_ID, "--scope", claudeScope(scope), "--json"],
      pluginRemove: (scope) => ["plugin", "uninstall", PLUGIN_ID, "--scope", claudeScope(scope), "--json"],
    },
    manual: (dir) => [`In Claude Code run: /plugin marketplace add ${dir}`, "Then: /plugin install pathrule@pathrule", "Then: /pathrule:setup"],
    nextSession: "Start a new Claude Code session (or run /reload-plugins) so the plugin loads",
    settingsHooks: true,
  },
  codex: {
    label: "Codex",
    binary: "codex",
    projectFiles: "`.pathrule/` and `.codex/config.toml`",
    install: {
      marketplaceAdd: (dir) => ["plugin", "marketplace", "add", dir, "--json"],
      marketplaceRemove: () => ["plugin", "marketplace", "remove", "pathrule"],
      pluginInstall: () => ["plugin", "add", PLUGIN_ID, "--json"],
      pluginRemove: () => ["plugin", "remove", PLUGIN_ID],
    },
    manual: (dir) => [`Run: codex plugin marketplace add ${dir}`, "Then: codex plugin add pathrule@pathrule", "Then ask Codex to use the pathrule-setup skill."],
    nextSession: "Start a new Codex session and trust Pathrule's hooks when Codex asks you to review them (or in /hooks)",
    settingsHooks: true,
  },
  cursor: {
    label: "Cursor",
    binary: "cursor-agent",
    projectFiles: "`.pathrule/`",
    // Cursor installs a marketplace plugin only from its own interface (/plugin, or the Marketplace).
    install: null,
    manual: (dir) => [
      "In Cursor open the Marketplace and install Pathrule, or add pathrule/pathrule as a team marketplace.",
      `Or copy ${dir}/plugins/cursor to ~/.cursor/plugins/local/pathrule and reload the window.`,
      "Then ask the agent to use the pathrule-setup skill.",
    ],
    nextSession: "Reload the Cursor window so the plugin's hooks and MCP server start",
    settingsHooks: false,
  },
  gemini: {
    label: "Gemini CLI",
    binary: "gemini",
    projectFiles: "`.pathrule/`",
    // Gemini installs an extension from a path or a repository; it has no project-scoped install.
    install: {
      marketplaceAdd: null,
      marketplaceRemove: null,
      pluginInstall: (_scope, dir) => ["extensions", "install", join(dir, "plugins", "gemini"), "--consent"],
      pluginRemove: () => ["extensions", "uninstall", "pathrule"],
    },
    manual: (dir) => [`Run: gemini extensions install ${join(dir, "plugins", "gemini")}`, "Then ask Gemini to use the pathrule-setup skill."],
    nextSession: "Start a new Gemini session so the extension's hooks and MCP server start",
    settingsHooks: false,
  },
  opencode: {
    label: "OpenCode",
    binary: "opencode",
    projectFiles: "`.pathrule/`",
    // OpenCode installs a plugin from npm into its global or the project's config.
    install: {
      marketplaceAdd: null,
      marketplaceRemove: null,
      pluginInstall: (scope) => ["plugin", "@pathrule/opencode", ...(scope === "user" ? ["--global"] : [])],
      // OpenCode has no command that removes a plugin.
      pluginRemove: null,
    },
    manual: () => ["Run: opencode plugin @pathrule/opencode --global", "Then ask OpenCode to use the pathrule-setup skill."],
    nextSession: "Restart OpenCode so the plugin and its MCP server load",
    settingsHooks: false,
  },
};

export function nativeProviderSpec(provider: IntegrationProviderId): NativeProviderSpec {
  return NATIVE_PROVIDER_SPECS[provider];
}
