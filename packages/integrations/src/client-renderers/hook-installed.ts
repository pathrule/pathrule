// SPDX-License-Identifier: Apache-2.0
// Which clients actually have the Pathrule hook installed in this workspace.
//
// This is the missing input to `resolveProtocolChannel`: signature mode is only
// safe when something really delivers the protocol, and "this client CAN run a
// hook" is not that something. A user who never installed it, or removed it, or
// whose settings file was rewritten by another tool, must keep the protocol on
// disk.
//
// Read-only by construction: it opens the per-client hook config files and looks
// for Pathrule's own hook command. Nothing here writes, and a missing or
// unreadable file always reads as NOT installed, because the direction of the
// error matters: guessing "installed" removes the protocol, guessing "not
// installed" only keeps a file slightly larger than it needs to be.

import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

/**
 * The hook config files each client reads, relative to the location they live
 * in. Taken from the paths the renderers and `safe-write.ts` actually own, not
 * from documentation: `.codex/hooks.json` (codex-renderer), `.cursor/hooks.json`
 * (cursor-renderer), `.github/hooks/pathrule.json` (copilot-renderer),
 * `.claude/settings.json` (safe-write's ensureClaudeSettingsHook).
 *
 * `user` entries are resolved against the home directory: Claude Code and Codex
 * both accept a user-level install, and a workspace whose hook lives there is
 * just as covered as one with a project-level file.
 */
export const HOOK_CONFIG_LOCATIONS: Readonly<
  Record<AgentTargetId, ReadonlyArray<{ scope: "project" | "user"; path: string }>>
> = {
  "claude-code": [
    { scope: "project", path: ".claude/settings.json" },
    { scope: "project", path: ".claude/settings.local.json" },
    { scope: "user", path: ".claude/settings.json" },
  ],
  codex: [
    { scope: "project", path: ".codex/hooks.json" },
    { scope: "user", path: ".codex/hooks.json" },
  ],
  cursor: [
    { scope: "project", path: ".cursor/hooks.json" },
    { scope: "user", path: ".cursor/hooks.json" },
  ],
  copilot: [{ scope: "project", path: ".github/hooks/pathrule.json" }],
  // No hook builder exists for Windsurf, so no location can prove one.
  windsurf: [],
};

/**
 * Does this config body install Pathrule's hook?
 *
 * The test is the hook SCRIPT NAME rather than the full resolved command,
 * because the command is an absolute path that differs per machine (and per
 * install location), while the script name is what every writer emits. Pure, so
 * the same rule applies to a file read from disk and to a body under test.
 */
export function configInstallsPathruleHook(body: string): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A hook config we cannot parse is a hook config we cannot rely on. Reading
    // the raw text for the script name would say "installed" for a file the
    // client itself will reject.
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return JSON.stringify(hooks).includes("pathrule-hook");
}
