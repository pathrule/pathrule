// SPDX-License-Identifier: Apache-2.0
// Single source of truth: which AgentTargetId maps to which installer(s).
// Orchestrators iterate over this; new clients just slot in here. Copilot is
// the one multi-config client (CLI config + VS Code user mcp.json), so every
// target maps to an ARRAY and consumers always iterate — there is no
// "primary installer" API to silently miss a config.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";
import { claudeInstaller } from "./claude-installer.js";
import { codexInstaller } from "./codex-installer.js";
import { copilotCliInstaller, copilotVscodeInstaller } from "./copilot-installer.js";
import { cursorInstaller } from "./cursor-installer.js";
import { windsurfInstaller } from "./windsurf-installer.js";
import type { ClientInstaller } from "./types.js";

export const INSTALLERS: Record<AgentTargetId, readonly ClientInstaller[]> = {
  "claude-code": [claudeInstaller],
  cursor: [cursorInstaller],
  codex: [codexInstaller],
  windsurf: [windsurfInstaller],
  copilot: [copilotCliInstaller, copilotVscodeInstaller],
};

export function getInstallers(id: AgentTargetId): readonly ClientInstaller[] {
  return INSTALLERS[id];
}

export type { ClientInstaller, InjectResult, RemoveResult } from "./types.js";
export { PATHRULE_SERVER_KEY } from "./types.js";
