// SPDX-License-Identifier: Apache-2.0
// "Connect AI Clients" — one command wires everything (plan §5.3/5.4):
// external client configs via the CLI's installer registry (verbatim reuse)
// + hook injection via syncCliWorkspace / syncLocalWorkspace. The result
// notification lists exactly what was written (transparency for a
// Marketplace audience). The user-level configs get the one MCP entry every
// folder uses: it names no edition, so the folder's edition is never written there.

import * as vscode from "vscode";

import { installEntryToCliTargets, parseInstallTargets } from "#cli/install-local.js";
import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

import type { BindingManager } from "../binding/manager.js";
import { requireCloud, type ExtensionCloud } from "../capabilities.js";
import { themeIcon } from "../ui/theme.js";
import { strings } from "../ui/strings.js";
import { buildExtensionMcpEntry } from "./mcp-entry.js";
import { supportsMcpProvider } from "./provider.js";

interface TargetItem extends vscode.QuickPickItem {
  target: AgentTargetId;
}

const TARGET_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  windsurf: "Windsurf",
  copilot: "GitHub Copilot",
};

export function registerConnectCommand(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  folder: string | null,
  bundledCliPath: string,
  cloud: ExtensionCloud | null,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.connectAgents", () =>
      connectAgents(manager, folder, bundledCliPath, cloud),
    ),
  );
}

async function connectAgents(
  manager: BindingManager,
  folder: string | null,
  bundledCliPath: string,
  cloud: ExtensionCloud | null,
): Promise<void> {
  const binding = manager.current();
  if (!folder || binding === null || binding.kind === "unbound") {
    await vscode.commands.executeCommand("pathrule.setUp");
    return;
  }

  const host = vscode.env.appName.toLowerCase();
  const targets = parseInstallTargets("all").map((target): TargetItem => {
    const isHostFork =
      (target === "cursor" && host.includes("cursor")) ||
      (target === "windsurf" && host.includes("windsurf"));
    return {
      target,
      label: TARGET_LABELS[target] ?? target,
      description: isHostFork ? strings.connect.thisEditor : undefined,
      detail: strings.connect.targetDetail(TARGET_LABELS[target] ?? target),
      picked: isHostFork || target === "claude-code",
      iconPath: themeIcon("brand"),
    };
  });

  const copilotNote = supportsMcpProvider() ? strings.connect.copilotAuto : null;
  const picked = await vscode.window.showQuickPick(targets, {
    title: strings.connect.pickTitle,
    placeHolder: copilotNote ?? undefined,
    canPickMany: true,
    ignoreFocusOut: true,
  });
  // Empty confirm = nothing to connect; treat as cancel instead of running
  // hook sync and toasting success (code-review fix #8).
  if (!picked || picked.length === 0) return;

  const written: string[] = [];
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: strings.connect.progressTitle },
      async () => {
        if (picked.length > 0) {
          const entry = buildExtensionMcpEntry({
            bundledCliPath,
            runtime: "node",
            execPath: process.execPath,
            env: process.env,
          });
          const results = await installEntryToCliTargets(
            picked.map((p) => p.target),
            entry,
            process.env,
          );
          for (const result of results) {
            if (result.ok) {
              written.push(
                strings.connect.wroteConfig(TARGET_LABELS[result.client] ?? result.client),
              );
            }
          }
        }
        // Hook injection — the CLI pipeline verbatim (hook script, settings
        // hook, protocol file, hook-index warm; cloud adds CLAUDE.md render),
        // for the folder's own workspace.
        if (binding.kind === "cloud") {
          await requireCloud(cloud).syncWorkspace(process.env, binding.workspaceId, folder);
        } else {
          // Lazy: sync-local statically imports LocalBackend (sqlite) — keep
          // it off the activation path (lazy-sqlite rule).
          const { syncLocalWorkspace } = await import("#cli/local/sync-local.js");
          await syncLocalWorkspace(process.env, folder, binding.workspaceId);
        }
        written.push(strings.connect.wroteHooks);
        if (copilotNote) written.push(strings.connect.copilotAuto);
      },
    );
  } catch {
    const doctor = await vscode.window.showErrorMessage(
      strings.connect.failed,
      strings.connect.runDoctor,
    );
    if (doctor === strings.connect.runDoctor) {
      await vscode.commands.executeCommand("pathrule.checkIntegration");
    }
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    strings.connect.done,
    { detail: written.map((w) => `• ${w}`).join("\n") },
    strings.connect.runDoctor,
  );
  if (choice === strings.connect.runDoctor) {
    await vscode.commands.executeCommand("pathrule.checkIntegration");
  }
}
