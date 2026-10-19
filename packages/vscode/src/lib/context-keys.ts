// SPDX-License-Identifier: Apache-2.0
// Declarative `when`-clause contexts derived from the binding + capabilities
// (plan rule: UI gates on capabilities, never `if (isCloud)` sprinkled around).

import * as vscode from "vscode";

import type { FolderBinding } from "../binding/types.js";

export async function applyContextKeys(binding: FolderBinding | null): Promise<void> {
  const bound = binding !== null && binding.kind !== "unbound";
  const caps = bound ? binding.backend.capabilities() : null;
  await Promise.all([
    set("pathrule.bound", bound),
    set("pathrule.mode", bound ? binding.kind : "none"),
    // Why an unbound folder is unbound (the welcome view's actionable message), else bound/none.
    set("pathrule.folderState", binding === null ? "none" : bound ? "bound" : binding.reason),
    set(
      "pathrule.signedIn",
      binding?.kind === "cloud" || (binding?.kind === "unbound" && binding.hasSession),
    ),
    set("pathrule.caps.cloud", binding?.kind === "cloud"),
    set("pathrule.caps.realtime", caps?.realtime ?? false),
  ]);
}

function set(key: string, value: unknown): Thenable<unknown> {
  return vscode.commands.executeCommand("setContext", key, value);
}
