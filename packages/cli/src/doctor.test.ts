// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeInstaller } from "@pathrule/integrations/mcp-installers/claude-installer.js";
import { codexInstaller } from "@pathrule/integrations/mcp-installers/codex-installer.js";
import type { McpServerEntry } from "@pathrule/integrations/mcp-types.js";
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { runCliDoctor } from "./doctor.js";
import { CLI_SHARED_PACKAGES, installCliPlugins, type CommandPlugin } from "./plugin.js";

// The entry Studio writes into every client: its own executable runs the server inside its bundle.
// Once Studio is uninstalled both files are gone, and the client can no longer start Pathrule. The
// bundle is placed under the test's home, since this machine may have Studio installed.
function studioEntry(home: string): McpServerEntry {
  const app = join(home, "Applications", "Pathrule.app", "Contents");
  return {
    type: "stdio",
    command: join(app, "MacOS", "Pathrule"),
    args: [join(app, "Resources", "pathrule-mcp-server", "index.js")],
    env: { ELECTRON_RUN_AS_NODE: "1", PATHRULE_SESSION_SURFACE: "desktop" },
  };
}

describe("runCliDoctor: MCP entries whose launch files are gone", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "pathrule-doctor-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(path: string, body: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  it("reports a removed Studio's entries as missing-file and names the open CLI's fix", async () => {
    const claudePath = claudeInstaller.homeConfigPath(home, process.platform);
    const codexPath = codexInstaller.homeConfigPath(home, process.platform);
    await writeConfig(claudePath, claudeInstaller.inject(null, studioEntry(home)).body);
    await writeConfig(codexPath, codexInstaller.inject(null, studioEntry(home)).body);

    const report = await runCliDoctor({ HOME: home }, home);

    const claude = report.mcp.find((m) => m.client === "claude-code");
    const codex = report.mcp.find((m) => m.client === "codex");
    expect(claude).toMatchObject({ installed: true, stale_reason: "missing-file" });
    expect(codex).toMatchObject({ installed: true, stale_reason: "missing-file" });
    const launch = report.checks.find((c) => c.name === "mcp_launch");
    expect(launch?.status).toBe("warn");
    expect(launch?.detail).toContain("claude-code:missing-file");
    // The open CLI has no `repair`; `install` rewrites the entry.
    expect(launch?.detail).toContain("pathrule install");
  });

  // The account edition's `pathrule repair` went with its legacy commands; doctor named it until
  // 2026-10-18, so a signed-in person was sent to an unknown command.
  it("names `pathrule install` with an account too", async () => {
    const account: CommandPlugin = {
      name: "cloud",
      contract: CLI_PLUGIN_CONTRACT,
      sharedPackages: CLI_SHARED_PACKAGES,
      account: {
        commands: {},
        mcpEntry: () => ({ type: "stdio" as const, command: "pathrule", args: ["mcp", "run"] }),
        afterInstall: async () => {},
        doctorChecks: async () => [],
        doctorNextStep: () => null,
        authorizeSupportBundle: async () => {},
        configUser: async () => "user",
        signedInUser: async () => null,
      },
    };
    const claudePath = claudeInstaller.homeConfigPath(home, process.platform);
    await writeConfig(claudePath, claudeInstaller.inject(null, studioEntry(home)).body);
    installCliPlugins([account]);
    try {
      const report = await runCliDoctor({ HOME: home }, home);
      const launch = report.checks.find((c) => c.name === "mcp_launch");
      expect(launch?.detail).toContain("pathrule install");
      expect(launch?.detail).not.toContain("pathrule repair");
    } finally {
      installCliPlugins([]);
    }
  });

  it("leaves an entry whose files exist alone", async () => {
    const launchable: McpServerEntry = {
      type: "stdio",
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), "mcp", "run"],
      env: { PATHRULE_LOCAL: "1" },
    };
    const claudePath = claudeInstaller.homeConfigPath(home, process.platform);
    await writeConfig(claudePath, claudeInstaller.inject(null, launchable).body);

    const report = await runCliDoctor({ HOME: home }, home);

    const claude = report.mcp.find((m) => m.client === "claude-code");
    expect(claude?.installed).toBe(true);
    expect(claude?.stale_reason).toBeUndefined();
    expect(report.checks.find((c) => c.name === "mcp_launch")).toBeUndefined();
  });
});
