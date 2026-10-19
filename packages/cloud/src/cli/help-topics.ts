// SPDX-License-Identifier: Apache-2.0
// `pathrule help surfaces|web`: where Pathrule Web and the VS Code extension fit beside the CLI.
import type { CliHelpTopic } from "@pathrule/cli/plugin.js";

import { PATHRULE_PRODUCT_DESCRIPTIONS, PATHRULE_PRODUCT_NAMES } from "./product-names.js";

export const ACCOUNT_HELP_TOPICS: readonly CliHelpTopic[] = [
  {
    name: "surfaces",
    rank: 10,
    text: `${PATHRULE_PRODUCT_NAMES.cli} surfaces

${PATHRULE_PRODUCT_NAMES.web}
  ${PATHRULE_PRODUCT_DESCRIPTIONS.web}
  Use for billing, team admin, visual review, and browser-based setup.

${PATHRULE_PRODUCT_NAMES.vscode}
  ${PATHRULE_PRODUCT_DESCRIPTIONS.vscode}
  Use when you work in VS Code: it binds the open folder and connects your AI clients from the editor.

${PATHRULE_PRODUCT_NAMES.cli}
  ${PATHRULE_PRODUCT_DESCRIPTIONS.cli}
  Use for terminal-first local runtime setup, scripts, and headless machines.

Cloud state is shared across surfaces. Local runtime state is scoped to this user and this machine.
`,
  },
  {
    name: "web",
    rank: 20,
    text: `${PATHRULE_PRODUCT_NAMES.web}

${PATHRULE_PRODUCT_DESCRIPTIONS.web}

Good for:
  - Billing and subscription management
  - Team members and invites
  - Visual workspace review

Useful commands:
  pathrule open workspace
  pathrule open workspace-settings
  pathrule open agent-setup
  pathrule billing
  pathrule team open
`,
  },
];
