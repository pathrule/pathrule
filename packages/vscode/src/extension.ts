// SPDX-License-Identifier: Apache-2.0
// The extension's composition root: the open foundation with Pathrule Cloud composed through the
// capability seam (./capabilities.ts). Local mode needs no account.

import type * as vscode from "vscode";

import { activateExtension, deactivateExtension } from "./activate.js";
import { cloudCapabilities } from "./cloud.js";

export function activate(context: vscode.ExtensionContext): void {
  activateExtension(context, cloudCapabilities());
}

export function deactivate(): Promise<void> {
  return deactivateExtension();
}
