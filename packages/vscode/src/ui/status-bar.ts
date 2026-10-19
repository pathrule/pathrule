// SPDX-License-Identifier: Apache-2.0
// Thin vscode adapter over the pure status-text model.

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import { deliveryTooltipLines, statusBarModel } from "./status-text.js";

export function createStatusBar(
  manager: BindingManager,
  disposables: vscode.Disposable[],
): {
  setActivePath(relativePath: string | null): void;
  setCounts(summary: string | null): void;
  setDelivery(scopes: Array<{ path: string; titles: string[] }> | null): void;
} {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  disposables.push(item);

  let activePath: string | null = null;
  let counts: string | null = null;
  let delivery: Array<{ path: string; titles: string[] }> | null = null;

  const render = (): void => {
    const model = statusBarModel(manager.current(), activePath, counts);
    item.text = model.text;
    if (delivery !== null) {
      // Zero-click "see what your agent sees" (owner round 17).
      const md = new vscode.MarkdownString(
        [model.tooltip, "", ...deliveryTooltipLines(delivery)].join("\n"),
      );
      item.tooltip = md;
    } else {
      item.tooltip = model.tooltip;
    }
    item.command = model.command;
    item.show();
  };

  render();
  const unsubscribe = manager.onDidChange(render);
  disposables.push(new vscode.Disposable(unsubscribe));

  return {
    setActivePath(relativePath) {
      activePath = relativePath;
      render();
    },
    setCounts(summary) {
      counts = summary;
      render();
    },
    setDelivery(scopes) {
      delivery = scopes;
      render();
    },
  };
}
