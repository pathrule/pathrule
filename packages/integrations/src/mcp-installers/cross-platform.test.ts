// SPDX-License-Identifier: Apache-2.0
// Platform and BOM fixtures for every MCP installer. These
// tests can run on any host because the installer API takes `homedir` and
// `platform` as parameters; we exercise the win32/darwin/linux matrix
// against synthetic Windows-shaped homes without monkey-patching
// `process.platform`.

import { describe, expect, it } from "vitest";

import { claudeInstaller } from "./claude-installer.js";
import { codexInstaller } from "./codex-installer.js";
import { cursorInstaller } from "./cursor-installer.js";
import { windsurfInstaller } from "./windsurf-installer.js";
import { defaultManagedEntryInfo, joinHomePath } from "./types.js";

const FRESH_ENTRY = {
  type: "stdio" as const,
  command: "C:\\Program Files\\nodejs\\node.exe",
  args: [
    "C:\\Users\\Pat Smith\\AppData\\Roaming\\npm\\node_modules\\@pathrule\\cli\\dist\\index.js",
    "mcp",
    "run",
  ],
  env: {
    PATHRULE_EXAMPLE_URL: "https://api.example.com",
    PATHRULE_EXAMPLE_KEY: "key",
    PATHRULE_HOME: "C:\\Users\\Pat Smith\\.pathrule home",
    HTTPS_PROXY: "http://proxy.corp.example:8080",
  },
};

describe("joinHomePath", () => {
  it("uses backslashes on win32 and forward slashes on POSIX", () => {
    expect(joinHomePath("win32", "C:\\Users\\Pat", ".codex", "config.toml")).toBe(
      "C:\\Users\\Pat\\.codex\\config.toml",
    );
    expect(joinHomePath("darwin", "/Users/pat", ".cursor", "mcp.json")).toBe(
      "/Users/pat/.cursor/mcp.json",
    );
    expect(joinHomePath("linux", "/home/pat", ".codeium", "windsurf", "mcp_config.json")).toBe(
      "/home/pat/.codeium/windsurf/mcp_config.json",
    );
  });

  it("tolerates trailing separators on the home dir and stripped slashes on segments", () => {
    expect(joinHomePath("darwin", "/Users/pat/", "/.claude.json")).toBe("/Users/pat/.claude.json");
    expect(joinHomePath("win32", "C:\\Users\\Pat\\", "\\.claude.json")).toBe(
      "C:\\Users\\Pat\\.claude.json",
    );
  });
});

describe("homeConfigPath across platforms", () => {
  const cases = [
    {
      label: "darwin",
      platform: "darwin" as NodeJS.Platform,
      home: "/Users/pat",
      claude: "/Users/pat/.claude.json",
      cursor: "/Users/pat/.cursor/mcp.json",
      codex: "/Users/pat/.codex/config.toml",
      windsurf: "/Users/pat/.codeium/windsurf/mcp_config.json",
    },
    {
      label: "linux",
      platform: "linux" as NodeJS.Platform,
      home: "/home/pat",
      claude: "/home/pat/.claude.json",
      cursor: "/home/pat/.cursor/mcp.json",
      codex: "/home/pat/.codex/config.toml",
      windsurf: "/home/pat/.codeium/windsurf/mcp_config.json",
    },
    {
      label: "win32 with spaces",
      platform: "win32" as NodeJS.Platform,
      home: "C:\\Users\\Pat Smith",
      claude: "C:\\Users\\Pat Smith\\.claude.json",
      cursor: "C:\\Users\\Pat Smith\\.cursor\\mcp.json",
      codex: "C:\\Users\\Pat Smith\\.codex\\config.toml",
      windsurf: "C:\\Users\\Pat Smith\\.codeium\\windsurf\\mcp_config.json",
    },
  ];

  for (const c of cases) {
    it(`computes the right paths on ${c.label}`, () => {
      expect(claudeInstaller.homeConfigPath(c.home, c.platform)).toBe(c.claude);
      expect(cursorInstaller.homeConfigPath(c.home, c.platform)).toBe(c.cursor);
      expect(codexInstaller.homeConfigPath(c.home, c.platform)).toBe(c.codex);
      expect(windsurfInstaller.homeConfigPath(c.home, c.platform)).toBe(c.windsurf);
    });
  }
});

describe("UTF-8 BOM round-trip", () => {
  const BOM = "﻿";

  it("Claude installer preserves a leading BOM on rewrite", () => {
    const original = `${BOM}${JSON.stringify({ otherKey: "keep" })}\n`;
    const injected = claudeInstaller.inject(original, FRESH_ENTRY);
    expect(injected.body.charCodeAt(0)).toBe(0xfeff);
    expect(injected.body.slice(1).startsWith("{")).toBe(true);
  });

  it("Cursor installer preserves a leading BOM and round-trips foreign keys", () => {
    const original = `${BOM}${JSON.stringify({
      mcpServers: { other: { command: "node", args: ["/opt/other.js"] } },
      uiTheme: "dark",
    })}\n`;
    const injected = cursorInstaller.inject(original, FRESH_ENTRY);
    expect(injected.body.charCodeAt(0)).toBe(0xfeff);
    const parsed = JSON.parse(injected.body.slice(1));
    expect(parsed.uiTheme).toBe("dark");
    expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["/opt/other.js"] });
    expect(parsed.mcpServers.pathrule).toBeDefined();
  });

  it("Windsurf installer drops the BOM when the source had none", () => {
    const original = JSON.stringify({ mcpServers: {} });
    const injected = windsurfInstaller.inject(original, FRESH_ENTRY);
    expect(injected.body.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("Codex installer round-trips a BOM on TOML rewrites", () => {
    const original = `${BOM}[mcp_servers.unrelated]\ncommand = "node"\nargs = ["/opt/other.js"]\n`;
    const injected = codexInstaller.inject(original, FRESH_ENTRY);
    expect(injected.body.charCodeAt(0)).toBe(0xfeff);
    expect(injected.body).toContain("[mcp_servers.unrelated]");
    expect(injected.body).toContain("[mcp_servers.pathrule]");
  });
});

describe("Codex TOML — Windows paths with spaces and backslashes", () => {
  it("round-trips a Windows command + args + env values through smol-toml", () => {
    const injected = codexInstaller.inject(null, FRESH_ENTRY);
    expect(injected.wasNew).toBe(true);
    // The serializer must escape backslashes and preserve spaces inside
    // double-quoted TOML strings.
    const reread = codexInstaller.read(injected.body);
    expect(reread?.command).toBe(FRESH_ENTRY.command);
    expect(reread?.args).toEqual(FRESH_ENTRY.args);
    expect(reread?.env?.PATHRULE_HOME).toBe(FRESH_ENTRY.env.PATHRULE_HOME);
    expect(reread?.env?.HTTPS_PROXY).toBe(FRESH_ENTRY.env.HTTPS_PROXY);
  });

  it("preserves unrelated MCP servers when injecting", () => {
    const original = `[mcp_servers.alpha]\ncommand = "node"\nargs = ["/opt/alpha.js"]\n`;
    const injected = codexInstaller.inject(original, FRESH_ENTRY);
    expect(injected.body).toContain("[mcp_servers.alpha]");
    expect(injected.body).toContain("[mcp_servers.pathrule]");
  });
});

describe("uninstall preserves unrelated entries across formats", () => {
  it("Cursor uninstall keeps foreign mcpServers and top-level keys intact", () => {
    const seeded = JSON.stringify(
      {
        mcpServers: {
          other: { command: "node", args: ["/opt/other.js"] },
          pathrule: { command: "node", args: ["/old.js"] },
        },
        uiTheme: "dark",
      },
      null,
      2,
    );
    const removed = cursorInstaller.remove(seeded);
    expect(removed.wasPresent).toBe(true);
    const parsed = JSON.parse(removed.body!);
    expect(parsed.uiTheme).toBe("dark");
    expect(parsed.mcpServers.pathrule).toBeUndefined();
    expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["/opt/other.js"] });
  });

  it("Codex uninstall keeps foreign mcp_servers and top-level keys intact", () => {
    const seeded = `[ui]
theme = "dark"

[mcp_servers.alpha]
command = "node"
args = ["/opt/alpha.js"]

[mcp_servers.pathrule]
command = "node"
args = ["/old.js"]
`;
    const removed = codexInstaller.remove(seeded);
    expect(removed.wasPresent).toBe(true);
    const body = removed.body!;
    expect(body).toContain("[mcp_servers.alpha]");
    expect(body).not.toContain("[mcp_servers.pathrule]");
    expect(body).toContain("[ui]");
  });
});

describe("getManagedEntry detects stale launch targets", () => {
  it("flags a repo-relative MCP server path as stale", () => {
    const staleEntry = {
      type: "stdio" as const,
      command: "/usr/local/bin/node",
      args: ["/some/repo/packages/mcp-server/dist/index.js"],
    };
    const info = defaultManagedEntryInfo(() => staleEntry, "ignored");
    expect(info.staleReason).toBe("repo-relative-mcp-server");
  });

  it("returns clean info for a fresh `pathrule mcp run` entry", () => {
    const info = defaultManagedEntryInfo(() => FRESH_ENTRY, "ignored");
    expect(info.present).toBe(true);
    expect(info.staleReason).toBeUndefined();
    expect(info.launchCommand).toBe(FRESH_ENTRY.command);
    expect(info.launchArgs).toEqual(FRESH_ENTRY.args);
  });

  it("reports absent entries cleanly", () => {
    const info = defaultManagedEntryInfo(() => null, "ignored");
    expect(info.present).toBe(false);
    expect(info.launchCommand).toBeNull();
    expect(info.launchArgs).toEqual([]);
  });
});
