// SPDX-License-Identifier: Apache-2.0
// On Windows the Claude Code hook command is the `.cmd` shim beside the script. Pathrule must still
// recognise that entry as its own: a sync that did not added one more entry every run, and eject
// left them all behind.
import { describe, expect, it } from "vitest";

import { setHookCommand } from "./hook-supervisor/hook-command.js";
import { ensureClaudeSettingsHook } from "./pathrule-protocol.js";

describe("the Claude Code hook on Windows", () => {
  it("is installed once, kept on the next sync, and removed on uninstall", () => {
    setHookCommand("C:\\Users\\Ada Lovelace\\.pathrule\\bin\\pathrule-hook.cmd");
    const first = ensureClaudeSettingsHook(JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./team-guard.sh" }] }] } }));
    expect(first.changed).toBe(true);
    const second = ensureClaudeSettingsHook(first.body);
    expect(second.changed).toBe(false);
    expect(second.body).toBe(first.body);
    const removed = JSON.parse(ensureClaudeSettingsHook(second.body, { uninstall: true }).body) as {
      hooks?: Record<string, unknown>;
    };
    expect(JSON.stringify(removed)).not.toContain("pathrule-hook");
    expect(JSON.stringify(removed)).toContain("./team-guard.sh");
  });
});
