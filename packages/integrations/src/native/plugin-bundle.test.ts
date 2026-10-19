// SPDX-License-Identifier: Apache-2.0
// The generated plugins: their wiring points at the launcher (never at a copy of the hook), every
// path stays inside the plugin, the public-directory edition has no hooks and no local process, and
// nothing proprietary or secret is in any generated file. The plugins' native validators run in the
// native verification script (`claude plugin validate`, `codex plugin marketplace add`).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOOK_EXTENSION_FILES } from "@pathrule/protocol/hook-extension.js";
import { SUPPORTED_HOOK_INDEX_SCHEMAS } from "@pathrule/protocol/hook-index.js";
import { LAUNCHER_CONTRACT } from "@pathrule/protocol/runtime-manifest.js";

import { claudeCodePlugin, codexDirectoryPlugin, codexPlugin, marketplaceBundle, type PluginBundleInput } from "./plugin-bundle.js";

const HERE = dirname(fileURLToPath(import.meta.url));

async function input(): Promise<PluginBundleInput> {
  return {
    pluginVersion: "0.7.0",
    minRuntime: "0.7.0",
    runtime: { package: "@pathrule/cli", version: "0.7.0", integrity: "sha512-pinned" },
    assets: {
      launcher: await readFile(join(HERE, "assets", "pathrule-launch.cjs"), "utf8"),
      setup: await readFile(join(HERE, "assets", "pathrule-setup.cjs"), "utf8"),
      license: await readFile(join(HERE, "..", "..", "LICENSE"), "utf8"),
      notice: await readFile(join(HERE, "..", "..", "NOTICE"), "utf8"),
    },
    remoteMcpUrl: "https://cloud.pathrule.io/mcp",
  };
}

const file = (files: { path: string; content: string }[], path: string) => {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`missing ${path}`);
  return found.content;
};

// Strings that would mean a proprietary part, a hosted secret or a machine path leaked in.
const FORBIDDEN = [
  /@pathrule\/intelligence-engine/,
  /@pathrule\/cloud\b/,
  /pathrule-hook-engine\.cjs/,
  /pathrule-hook-cloud\.cjs/,
  /cloud-semantic-query/,
  /supabase\.co/i,
  /SUPABASE_ANON_KEY\s*[:=]\s*["'][^"']+/,
  /sk-[A-Za-z0-9]{20,}/,
  /eyJ[A-Za-z0-9_-]{20,}\./,
  /\/Users\/[A-Za-z]/,
  /LicenseRef-Pathrule-Proprietary/,
  /\u2014/,
];

describe("generated provider plugins", () => {
  it("wire Claude Code's hooks and MCP server to the launcher, never to a copy of the hook", async () => {
    const files = claudeCodePlugin(await input());
    const hooks = JSON.parse(file(files, "hooks/hooks.json"));
    const commands = Object.values(hooks.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .flat()
      .flatMap((m) => m.hooks.map((h) => h.command));
    expect(commands.length).toBeGreaterThan(5);
    for (const c of commands) expect(c).toBe('sh "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-launch" hook --mcp=bundled');
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]),
    );
    expect(JSON.parse(file(files, ".mcp.json")).mcpServers.pathrule.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/scripts/pathrule-launch",
      "mcp",
    ]);
    expect(files.some((f) => f.path.endsWith("pathrule-hook.js"))).toBe(false);
    expect(JSON.parse(file(files, ".claude-plugin/plugin.json"))).toMatchObject({ name: "pathrule", version: "0.7.0", license: "Apache-2.0" });
  });

  it("bake this plugin's pins into the launcher and the setup script", async () => {
    const launcher = file(claudeCodePlugin(await input()), "scripts/pathrule-launch");
    expect(launcher).toContain('"minRuntime":"0.7.0"');
    expect(launcher).toContain('"integrity":"sha512-pinned"');
    expect(launcher).toContain(`"launcherContract":${LAUNCHER_CONTRACT}`);
    expect(file(codexPlugin(await input()), "scripts/pathrule-setup")).toContain('"provider":"codex"');
  });

  it("start Codex's MCP server through PLUGIN_ROOT, ship no plugin hooks, and keep the directory edition remote-only", async () => {
    const codex = codexPlugin(await input());
    // codex-cli 0.161 runs no plugin-bundled hook; setup writes a trusted hooks layer instead.
    expect(codex.some((f) => f.path.startsWith("hooks/"))).toBe(false);
    const server = JSON.parse(file(codex, "mcp.json")).mcpServers.pathrule;
    expect(server).toMatchObject({ type: "stdio", command: "sh" });
    expect(server.args.join(" ")).toContain("$PLUGIN_ROOT/scripts/pathrule-launch");
    const directory = codexDirectoryPlugin(await input());
    expect(directory.some((f) => f.path.startsWith("hooks/") || f.path.startsWith("scripts/"))).toBe(false);
    const mcp = JSON.parse(file(directory, "mcp.json")).mcpServers.pathrule;
    expect(mcp).toMatchObject({ type: "streamable-http", url: "https://cloud.pathrule.io/mcp" });
    expect(mcp.command).toBeUndefined();
  });

  it("list one Pathrule product per provider in the marketplace", async () => {
    const files = marketplaceBundle(await input());
    expect(JSON.parse(file(files, ".claude-plugin/marketplace.json")).plugins.map((p: { name: string }) => p.name)).toEqual(["pathrule"]);
    expect(JSON.parse(file(files, ".agents/plugins/marketplace.json")).plugins.map((p: { name: string }) => p.name)).toEqual(["pathrule"]);
    for (const f of files) expect(f.path.startsWith("/") || f.path.includes("..")).toBe(false);
  });

  it("install from Pathrule's open-source repository, whose root is the marketplace", async () => {
    const files = marketplaceBundle(await input());
    expect(JSON.parse(file(files, "plugins/claude-code/.claude-plugin/plugin.json")).repository).toBe("https://github.com/pathrule/pathrule");
    expect(file(files, "plugins/claude-code/README.md")).toContain("/plugin marketplace add pathrule/pathrule");
    expect(file(files, "plugins/codex/README.md")).toContain("codex plugin marketplace add pathrule/pathrule");
    for (const f of files) expect(f.content).not.toContain("pathrule/agent-plugins");
  });

  it("carry nothing proprietary, secret or machine-specific", async () => {
    for (const f of marketplaceBundle(await input())) {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(f.content)) throw new Error(`${f.path} matches ${pattern}`);
      }
    }
    // The hook extension names are proprietary files' names; the plugin must not even name them.
    for (const name of Object.values(HOOK_EXTENSION_FILES)) {
      expect(marketplaceBundle(await input()).some((f) => f.content.includes(name))).toBe(false);
    }
  });

  it("the hook reads exactly the index schemas the protocol declares", async () => {
    const hook = await readFile(join(HERE, "..", "hook-supervisor", "pathrule-hook.js"), "utf8");
    expect(hook).toContain(`const SUPPORTED_INDEX_SCHEMAS = new Set([${SUPPORTED_HOOK_INDEX_SCHEMAS.join(", ")}]);`);
  });
});
