// SPDX-License-Identifier: Apache-2.0
// Status-bar Quick Menu (owner round 17): one hub for mode info + the
// high-frequency actions. Items adapt to the binding (cloud/local).

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import { themeIcon } from "./theme.js";
import { strings } from "./strings.js";

interface MenuItem extends vscode.QuickPickItem {
  command?: string;
}

export function registerQuickMenu(context: vscode.ExtensionContext, manager: BindingManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.quickMenu", async () => {
      const binding = manager.current();
      if (binding === null || binding.kind === "unbound") {
        await vscode.commands.executeCommand("pathrule.setUp");
        return;
      }
      const header = `${binding.workspaceName ?? "Pathrule workspace"} · ${
        binding.kind === "cloud" ? strings.statusBar.modeCloud : strings.statusBar.modeLocal
      }`;
      const items: MenuItem[] = [
        { label: header, kind: vscode.QuickPickItemKind.Separator },
        {
          label: strings.menu.browse,
          iconPath: themeIcon("brand"),
          command: "pathrule.browseKnowledge",
        },
        {
          label: strings.menu.search,
          iconPath: themeIcon("brand"),
          command: "pathrule.searchKnowledge",
        },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        {
          label: strings.menu.connect,
          iconPath: themeIcon("brand"),
          command: "pathrule.connectAgents",
        },
        {
          label: strings.menu.doctor,
          iconPath: themeIcon("brand"),
          command: "pathrule.checkIntegration",
        },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...(binding.kind === "cloud"
          ? [
              {
                label: strings.menu.switchOrg,
                iconPath: themeIcon("organization"),
                command: "pathrule.switchOrganization",
              },
              {
                label: strings.menu.team,
                iconPath: themeIcon("cloud"),
                command: "pathrule.openTeamOnWeb",
              },
              {
                label: strings.menu.signOut,
                iconPath: themeIcon("organization"),
                command: "pathrule.signOut",
              },
            ]
          : [
              {
                label: strings.menu.pushToCloud,
                iconPath: themeIcon("cloud"),
                command: "pathrule.pushToCloud",
              },
            ]),
      ];
      const picked = await vscode.window.showQuickPick(items, { title: strings.menu.title });
      if (picked?.command) await vscode.commands.executeCommand(picked.command);
    }),
  );
}
