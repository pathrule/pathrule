// SPDX-License-Identifier: Apache-2.0
// The names and one-line descriptions the account commands print for Pathrule's surfaces. The
// CLI's own are the open CLI's.
import { CLI_PRODUCT_DESCRIPTION, CLI_PRODUCT_NAME } from "@pathrule/cli/help.js";

export const PATHRULE_PRODUCT_NAMES = {
  web: "Pathrule Web",
  vscode: "Pathrule for VS Code",
  cli: CLI_PRODUCT_NAME,
} as const;

export const PATHRULE_PRODUCT_DESCRIPTIONS = {
  web: "Pathrule in your browser. Manage your organization, team, and billing from anywhere.",
  vscode:
    "The Pathrule extension for VS Code. The CLI's local runtime inside the editor, Copilot included.",
  cli: CLI_PRODUCT_DESCRIPTION,
} as const;
