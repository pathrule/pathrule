// SPDX-License-Identifier: Apache-2.0
// "Check Integration" — all-issues-at-once doctor (pathrule-admin style).
// Output channel table; notification only when something is wrong.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { resolveCliHookScriptPaths } from "#cli/hook-script-install.js";
import { parseInstallTargets } from "#cli/install-local.js";
import { getInstallers } from "@pathrule/integrations/mcp-installers/registry.js";

import type { BindingManager } from "../binding/manager.js";
import { unboundModel } from "../ui/status-text.js";
import { strings } from "../ui/strings.js";
import { currentUpdateView, pathrulePolicy } from "../updates/check.js";
import { supportsMcpProvider } from "./provider.js";

interface DoctorCheck {
  name: string;
  ok: boolean;
  note: string;
  /** Informational only — rendered "○", never counted as an issue (e.g. a client the user chose not to connect). */
  neutral?: boolean;
}

export function registerDoctorCommand(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  folder: string | null,
  bundledCliPath: string,
): void {
  const channel = vscode.window.createOutputChannel("Pathrule");
  context.subscriptions.push(
    channel,
    vscode.commands.registerCommand("pathrule.checkIntegration", () =>
      runDoctor(context, channel, manager, folder, bundledCliPath),
    ),
  );
}

async function runDoctor(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  manager: BindingManager,
  folder: string | null,
  bundledCliPath: string,
): Promise<void> {
  const binding = manager.current();
  // Its own version first: what is installed, from which marketplace, and whether an update applies.
  const updates = currentUpdateView(context, await pathrulePolicy());
  const checks: DoctorCheck[] = [
    {
      name: strings.updates.doctorName,
      ok: updates.status !== "update_required",
      neutral: updates.status !== "update_required",
      note:
        updates.notice && updates.status !== "up_to_date"
          ? `${updates.summary}. ${updates.notice.message}`
          : updates.summary,
    },
  ];

  if (binding === null || binding.kind === "unbound" || !folder) {
    checks.push({
      name: "Workspace",
      ok: false,
      // Why the folder shows nothing, in the words the status bar uses.
      note:
        binding?.kind === "unbound"
          ? unboundModel(binding).tooltip
          : "folder not connected. Run Set Up Workspace.",
    });
  } else {
    checks.push({
      name: "Workspace",
      ok: true,
      note: `${binding.kind} · ${binding.workspaceId.slice(0, 8)}…`,
    });

    // MCP entries per external client. An unconnected client is a CHOICE,
    // not an issue (owner review round 3) — neutral unless present-but-stale.
    for (const target of parseInstallTargets("all")) {
      for (const installer of getInstallers(target)) {
        // Multi-config clients (copilot) disambiguate via configLabel.
        const name = installer.configLabel
          ? `MCP config · ${target} (${installer.configLabel})`
          : `MCP config · ${target}`;
        const configPath = installer.homeConfigPath(homedir(), process.platform);
        const existing = await readIfPresent(configPath);
        const managed = existing ? installer.getManagedEntry(existing) : null;
        if (managed?.present) {
          // Healthy = the configured server file exists (launchable). A path
          // from a previous extension version still works; nudge neutrally
          // instead of flagging an issue after every update (review fix #4).
          const configuredPath = managed.launchArgs.find((arg) => arg.endsWith("index.js"));
          const launchable = configuredPath ? await exists(configuredPath) : false;
          const current = managed.launchArgs.some((arg) => arg === bundledCliPath);
          checks.push({
            name,
            ok: launchable,
            neutral: launchable && !current,
            note: !launchable
              ? "configured server file is missing. Run Connect AI Clients."
              : current
                ? configPath
                : "works, but points at a previous build. Connect AI Clients refreshes it.",
          });
        } else {
          checks.push({
            name,
            ok: true,
            neutral: true,
            note: "not connected. Connect AI Clients adds it.",
          });
        }
      }
    }

    // Copilot provider availability (in-host). A fork without the API is a
    // fact about the editor, not a fixable issue — neutral there.
    checks.push({
      name: "Copilot agent mode",
      ok: true,
      neutral: !supportsMcpProvider(),
      note: supportsMcpProvider()
        ? "registered automatically by the extension"
        : "this editor doesn't support extension MCP providers. Config files cover it.",
    });

    // Hook script + workspace files.
    const hookPaths = resolveCliHookScriptPaths(process.env);
    checks.push({
      name: "Hook script",
      ok: await exists(hookPaths.scriptPath),
      note: hookPaths.scriptPath,
    });
    const settingsPath = path.join(folder, ".claude", "settings.json");
    const settings = await readIfPresent(settingsPath);
    checks.push({
      name: "Claude settings hook",
      ok: Boolean(settings && settings.includes("pathrule")),
      note: settingsPath,
    });
    const protocolPath = path.join(folder, ".claude", "rules", "pathrule-protocol.md");
    checks.push({
      name: "Protocol rules file",
      ok: await exists(protocolPath),
      note: protocolPath,
    });

    // MCP server spawn probe via the bundled CLI.
    checks.push(await spawnProbe(bundledCliPath));
  }

  render(channel, checks);
  const issues = checks.filter((c) => !c.ok).length;
  if (issues > 0) {
    const fix = await vscode.window.showWarningMessage(
      strings.doctor.issues(issues),
      strings.doctor.fix,
    );
    if (fix === strings.doctor.fix) {
      await vscode.commands.executeCommand("pathrule.connectAgents");
    }
  }
}

/**
 * Probe with the SAME runtime external clients use: `node` from PATH (their
 * configs say command:"node"). Probing electron-as-node would validate a
 * runtime no external client launches (code-review fix #5).
 */
async function spawnProbe(bundledCliPath: string): Promise<DoctorCheck> {
  const result = await new Promise<"ok" | "failed" | "no-node">((resolve) => {
    const child = spawn("node", [bundledCliPath, "--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    child.on("exit", (code) => resolve(code === 0 ? "ok" : "failed"));
    child.on("error", (err) =>
      resolve((err as NodeJS.ErrnoException).code === "ENOENT" ? "no-node" : "failed"),
    );
  });
  return {
    name: "MCP server (node runtime)",
    ok: result === "ok",
    note:
      result === "ok"
        ? bundledCliPath
        : result === "no-node"
          ? "Node 22.14+ not found on PATH. External AI clients launch the server with node."
          : "bundled CLI failed to run with node",
  };
}

function render(channel: vscode.OutputChannel, checks: DoctorCheck[]): void {
  channel.clear();
  channel.appendLine("Pathrule integration check");
  channel.appendLine("");
  for (const check of checks) {
    const mark = check.neutral ? "○" : check.ok ? "✓" : "✗";
    channel.appendLine(`${mark} ${check.name.padEnd(26)} ${check.note}`);
  }
  const issues = checks.filter((c) => !c.ok).length;
  channel.appendLine("");
  channel.appendLine(issues === 0 ? strings.doctor.allGood : strings.doctor.issues(issues));
  channel.show(true);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}
