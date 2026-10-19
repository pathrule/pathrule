// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  pluginActivation,
  pluginUpdateCommands,
  readClaudeCodePluginState,
  readCodexPluginState,
  readPluginLauncherConfig,
} from "./host-plugin-state.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-host-plugins-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function launcher(dir: string, config: Record<string, unknown>): void {
  write(
    join(dir, "scripts", "pathrule-launch"),
    `#!/bin/sh\n":"; //; exec node "$0" "$@"\nconst PLUGIN = /*@pathrule-plugin-config*/ ${JSON.stringify(config)} /*@end-pathrule-plugin-config*/;\n`,
  );
}

function claudeInstall(
  options: { source?: unknown; autoUpdate?: boolean; settings?: unknown } = {},
) {
  const installPath = join(home, ".claude", "plugins", "cache", "pathrule", "pathrule", "1.0.0");
  write(join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "posthog@posthog": [{ scope: "user", installPath: "/x", version: "9.9.9" }],
      "pathrule@pathrule": [{ scope: "user", installPath, version: "1.0.0" }],
    },
  });
  write(join(home, ".claude", "plugins", "known_marketplaces.json"), {
    pathrule: {
      source: options.source ?? { source: "github", repo: "pathrule/pathrule" },
      installLocation: "/x",
      ...(options.autoUpdate === undefined ? {} : { autoUpdate: options.autoUpdate }),
    },
  });
  if (options.settings) write(join(home, ".claude", "settings.json"), options.settings);
  launcher(installPath, { version: "1.0.0", minRuntime: "1.0.0", launcherContract: 1 });
}

describe("Claude Code's Pathrule plugin", () => {
  it("is absent when Claude Code has not installed it", () => {
    expect(readClaudeCodePluginState({ env: {}, home }).installed).toBe(false);
  });

  it("reads the version, the marketplace and the plugin's launcher config", () => {
    claudeInstall();
    const state = readClaudeCodePluginState({ env: {}, home });
    expect(state).toMatchObject({
      installed: true,
      id: "pathrule@pathrule",
      version: "1.0.0",
      marketplace: { name: "pathrule", source: "github", location: "pathrule/pathrule" },
      launcher: { version: "1.0.0", minRuntime: "1.0.0", launcherContract: 1 },
    });
  });

  it("follows the host's auto-update precedence: settings, then the toggle, then off by default", () => {
    claudeInstall();
    expect(readClaudeCodePluginState({ env: {}, home })).toMatchObject({
      autoUpdate: false,
      autoUpdateReason: "off by default for this marketplace",
    });
    claudeInstall({ autoUpdate: true });
    expect(readClaudeCodePluginState({ env: {}, home })).toMatchObject({ autoUpdate: true });
    claudeInstall({
      autoUpdate: true,
      settings: { extraKnownMarketplaces: { pathrule: { autoUpdate: false } } },
    });
    expect(readClaudeCodePluginState({ env: {}, home })).toMatchObject({
      autoUpdate: false,
      autoUpdateReason: "set in Claude Code settings",
    });
  });

  it("respects Claude Code's update switches, from the environment or its settings", () => {
    claudeInstall({ autoUpdate: true });
    expect(readClaudeCodePluginState({ env: { DISABLE_AUTOUPDATER: "1" }, home }).autoUpdate).toBe(
      false,
    );
    expect(
      readClaudeCodePluginState({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" }, home })
        .autoUpdate,
    ).toBe(false);
    expect(
      readClaudeCodePluginState({
        env: { DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" },
        home,
      }).autoUpdate,
    ).toBe(true);
    claudeInstall({ autoUpdate: true, settings: { env: { DISABLE_UPDATES: "1" } } });
    expect(readClaudeCodePluginState({ env: {}, home }).autoUpdate).toBe(false);
  });

  it("names the host's own update commands and when the new version runs", () => {
    claudeInstall();
    const state = readClaudeCodePluginState({ env: {}, home });
    expect(pluginUpdateCommands(state)).toEqual([
      "claude plugin marketplace update pathrule",
      "claude plugin update pathrule@pathrule",
    ]);
    expect(pluginActivation(state)).toBe(
      "It takes effect after /reload-plugins or in a new session.",
    );
    // The marketplace `pathrule integrations` writes is rewritten by this CLI first.
    const pathruleHome = { PATHRULE_HOME: join(home, ".pathrule") };
    claudeInstall({
      source: { source: "directory", path: join(home, ".pathrule", "integrations", "marketplace") },
    });
    expect(
      pluginUpdateCommands(readClaudeCodePluginState({ env: {}, home }), pathruleHome)[0],
    ).toBe("pathrule integrations repair");
    // Anyone else's local marketplace is only read again.
    claudeInstall({ source: { source: "directory", path: join(home, "checkout") } });
    expect(
      pluginUpdateCommands(readClaudeCodePluginState({ env: {}, home }), pathruleHome),
    ).toEqual([
      "claude plugin marketplace update pathrule",
      "claude plugin update pathrule@pathrule",
    ]);
  });
});

describe("Codex's Pathrule plugin", () => {
  const cached = (versions: string[]) => {
    for (const version of versions) {
      launcher(join(home, ".codex", "plugins", "cache", "pathrule", "pathrule", version), {
        version,
        launcherContract: 1,
      });
    }
  };
  const marketplace = (sourceType: "local" | "git", source: string) =>
    write(
      join(home, ".codex", "config.toml"),
      `[marketplaces.pathrule]\nsource_type = "${sourceType}"\nsource = "${source}"\n\n[plugins."pathrule@pathrule"]\nenabled = true\n`,
    );

  it("reads the newest cached version and never claims Codex updates it by itself", () => {
    cached(["0.9.0", "1.0.0", "1.0.0-rc.1"]);
    marketplace("git", "https://github.com/pathrule/pathrule.git");
    const state = readCodexPluginState({ env: {}, home });
    expect(state).toMatchObject({
      installed: true,
      id: "pathrule@pathrule",
      version: "1.0.0",
      autoUpdate: false,
      marketplace: { source: "git", location: "https://github.com/pathrule/pathrule.git" },
    });
    expect(pluginUpdateCommands(state)).toEqual([
      "codex plugin marketplace upgrade pathrule",
      "codex plugin add pathrule@pathrule",
    ]);
    expect(pluginActivation(state)).toBe("It takes effect in a new Codex session.");
  });

  it("re-adds from a local marketplace, which `marketplace upgrade` refuses", () => {
    cached(["1.0.0"]);
    marketplace("local", "/home/a/checkout/pathrule");
    const state = readCodexPluginState({ env: {}, home });
    expect(state.marketplace).toMatchObject({ source: "directory" });
    expect(pluginUpdateCommands(state)).toEqual(["codex plugin add pathrule@pathrule"]);
  });

  it("is absent without a cache, and honours CODEX_HOME", () => {
    expect(readCodexPluginState({ env: {}, home }).installed).toBe(false);
    launcher(join(home, "elsewhere", "plugins", "cache", "pathrule", "pathrule", "1.0.0"), {
      version: "1.0.0",
    });
    expect(
      readCodexPluginState({ env: { CODEX_HOME: join(home, "elsewhere") }, home }).installed,
    ).toBe(true);
  });
});

describe("the plugin's launcher config", () => {
  it("is null for a script without one or with a broken one", () => {
    expect(readPluginLauncherConfig(home)).toBeNull();
    write(
      join(home, "scripts", "pathrule-launch"),
      "/*@pathrule-plugin-config*/ {nope /*@end-pathrule-plugin-config*/",
    );
    expect(readPluginLauncherConfig(home)).toBeNull();
  });
});
