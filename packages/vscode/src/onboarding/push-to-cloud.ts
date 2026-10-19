// SPDX-License-Identifier: Apache-2.0
// Push to Cloud (owner round 17, plan's deferred conversion step): copy a
// LOCAL workspace's content + structure into a fresh cloud workspace bound to
// the same folder, record that this folder now uses Pathrule Cloud (this project
// only), then rebind. The local store stays untouched and dormant: it is never
// served for a Cloud folder. Activity history deliberately stays local.

import * as path from "node:path";

import * as vscode from "vscode";

import { recordProjectEdition } from "../binding/folder-mode.js";
import type { BindingManager } from "../binding/manager.js";
import type { BoundFolder } from "../binding/types.js";
import type { ExtensionCloud } from "../capabilities.js";
import { strings } from "../ui/strings.js";

export function registerPushToCloud(
  context: vscode.ExtensionContext,
  manager: BindingManager,
  folder: string | null,
  cloud: ExtensionCloud | null,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pathrule.pushToCloud", () =>
      cloud
        ? pushToCloud(manager, folder, cloud)
        : vscode.window.showInformationMessage(strings.onboarding.cloudUnavailable),
    ),
  );
}

async function pushToCloud(
  manager: BindingManager,
  folder: string | null,
  cloud: ExtensionCloud,
): Promise<void> {
  const binding = manager.current();
  if (!folder || binding === null || binding.kind !== "local") return;

  if (!(await cloud.hasSession(process.env))) {
    void vscode.window.showInformationMessage(strings.push.needsSignIn);
    const ok = await vscode.commands.executeCommand("pathrule.signIn");
    if (!ok || !(await cloud.hasSession(process.env))) return;
  }
  // Bind-don't-duplicate guard (code-review fix #2): if this folder already
  // resolves to a cloud workspace (signed in just now, stale local binding),
  // never create a second one — rebind instead.
  if (await cloud.resolveBinding(folder, process.env)) {
    await recordProjectEdition(process.env, folder, "cloud");
    void vscode.window.showInformationMessage(strings.push.alreadyCloud);
    await manager.revalidate();
    return;
  }
  // Org choice is the only decision; cancel = abort.
  if (!(await vscode.commands.executeCommand("pathrule.switchOrganization"))) return;

  const counts = { memories: 0, rules: 0, skills: 0 };
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: strings.push.progress,
      },
      async (progress) => {
        // 1. Fresh cloud workspace bound to this folder, which the person moves to Pathrule Cloud
        //    by running this command: without that choice its two workspaces would conflict.
        await cloud.createWorkspace(path.basename(folder), folder, process.env);
        await recordProjectEdition(process.env, folder, "cloud");
        const target = await cloud.resolveBinding(folder, process.env);
        if (!target) throw new Error("cloud workspace did not resolve after create");

        // 2. Copy structure + content, path by path (most generic first so
        //    parents exist before children).
        const overview = await binding.backend.workspaceOverview(binding.workspaceId);
        overview.sort((a, b) => a.relative_path.length - b.relative_path.length);
        for (const entry of overview) {
          const targetPath = entry.relative_path === "" ? "/" : entry.relative_path;
          const node = await target.backend.ensureNodeForPath(target.workspaceId, targetPath);
          for (const m of entry.memories) {
            const full = await binding.backend.readMemory(m.id);
            if (!full) continue;
            progress.report({ message: strings.push.progressItem(full.title) });
            await target.backend.writeMemory({
              workspaceId: target.workspaceId,
              nodeId: node.id,
              title: full.title,
              content: full.content,
              source: "manual",
            });
            counts.memories += 1;
          }
          for (const r of entry.rules) {
            const full = await binding.backend.readRule(r.id);
            if (!full) continue;
            progress.report({ message: strings.push.progressItem(full.name) });
            await target.backend.writeRule({
              workspaceId: target.workspaceId,
              nodeId: node.id,
              name: full.name,
              content: full.content,
              scopeType: full.scopeType as "folder" | "file_type" | "project",
              priority: full.priority as "high" | "medium" | "low",
            });
            counts.rules += 1;
          }
          for (const s of entry.skills) {
            const full = await binding.backend.readSkill(s.id);
            if (!full) continue;
            progress.report({ message: strings.push.progressItem(full.name) });
            await target.backend.writeSkill({
              workspaceId: target.workspaceId,
              nodeId: node.id,
              name: full.name,
              content: full.content,
              description: (full as { description?: string | null }).description ?? null,
              source: full.source === "github_ref" ? "github_ref" : "manual",
              githubUrl: (full as { githubUrl?: string | null }).githubUrl ?? null,
              tags: (full as { tags?: string[] }).tags ?? [],
            });
            counts.skills += 1;
          }
        }

        // 3. Rebind: the folder's edition is now Pathrule Cloud.
        await manager.revalidate();
      },
    );
  } catch {
    void vscode.window.showErrorMessage(strings.push.failed);
    await manager.revalidate();
    return;
  }

  const connect = await vscode.window.showInformationMessage(
    strings.push.done(counts.memories, counts.rules, counts.skills),
    { detail: strings.push.note },
    strings.onboarding.readyConnect,
  );
  if (connect === strings.onboarding.readyConnect) {
    await vscode.commands.executeCommand("pathrule.connectAgents");
  }
}

export type { BoundFolder };
