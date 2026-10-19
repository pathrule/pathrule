// SPDX-License-Identifier: Apache-2.0
// "Recent Activity" view — recentActivities over the bound backend. Same
// component for both modes (local shows the single-principal log).

import * as vscode from "vscode";

import type { Activity } from "@pathrule/core";

import type { BindingManager } from "../binding/manager.js";
import { themeIcon } from "../ui/theme.js";
import { activityRow } from "./activity-format.js";

const FEED_LIMIT = 20;

export class ActivityFeedProvider implements vscode.TreeDataProvider<Activity> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  private rows: Activity[] = [];

  constructor(private readonly manager: BindingManager) {}

  async refresh(): Promise<void> {
    const binding = this.manager.current();
    if (binding === null || binding.kind === "unbound") {
      this.rows = [];
    } else {
      this.rows = await binding.backend.recentActivities(
        { workspaceId: binding.workspaceId, relativePath: "" },
        FEED_LIMIT,
      );
    }
    this.changed.fire();
  }

  getTreeItem(activity: Activity): vscode.TreeItem {
    const model = activityRow(activity, Date.now());
    const item = new vscode.TreeItem(model.label, vscode.TreeItemCollapsibleState.None);
    item.id = `activity:${activity.id}`;
    item.description = model.description;
    item.tooltip = model.tooltip;
    item.iconPath = themeIcon("brand");
    item.accessibilityInformation = { label: `${model.label}, ${model.description}` };
    return item;
  }

  getChildren(element?: Activity): Activity[] {
    return element ? [] : this.rows;
  }
}
