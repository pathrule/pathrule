// SPDX-License-Identifier: Apache-2.0
// Copilot agent mode integration: vscode.lm.registerMcpServerDefinitionProvider.
// Feature-detected — VSCode forks (Cursor/Windsurf) lack the API and use the
// installer-registry path instead (design spec §3: verified Cursor gap).

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import { buildExtensionMcpEntry } from "./mcp-entry.js";

type LmWithMcp = typeof vscode.lm & {
  registerMcpServerDefinitionProvider?: (
    id: string,
    provider: {
      onDidChangeMcpServerDefinitions?: vscode.Event<void>;
      provideMcpServerDefinitions: () => vscode.ProviderResult<unknown[]>;
    },
  ) => vscode.Disposable;
};

export function supportsMcpProvider(): boolean {
  const lm = vscode.lm as LmWithMcp | undefined;
  return (
    typeof lm?.registerMcpServerDefinitionProvider === "function" &&
    typeof (vscode as unknown as { McpStdioServerDefinition?: unknown })
      .McpStdioServerDefinition === "function"
  );
}

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  bundledCliPath: string,
): void {
  if (!supportsMcpProvider()) return;
  const lm = vscode.lm as LmWithMcp;
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    new vscode.Disposable(manager.onDidChange(() => changed.fire())),
    lm.registerMcpServerDefinitionProvider!("pathrule.mcp", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const binding = manager.current();
        if (binding === null || binding.kind === "unbound") return [];
        // One entry whatever the folder's edition: the server resolves each call's folder.
        const entry = buildExtensionMcpEntry({
          bundledCliPath,
          runtime: "electron",
          execPath: process.execPath,
          env: process.env,
        });
        const Definition = (
          vscode as unknown as {
            McpStdioServerDefinition: new (
              label: string,
              command: string,
              args: string[],
              env: Record<string, string>,
            ) => unknown;
          }
        ).McpStdioServerDefinition;
        return [new Definition("Pathrule", entry.command, entry.args, entry.env ?? {})];
      },
    }),
  );
}
