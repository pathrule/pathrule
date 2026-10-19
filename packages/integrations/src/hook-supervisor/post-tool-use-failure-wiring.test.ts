// SPDX-License-Identifier: Apache-2.0
// Guards the PostToolUseFailure wiring, added 2026-08-22.
//
// Claude Code routes tool FAILURES to PostToolUseFailure and sends no PostToolUse for
// them, so without that matcher registered the friction pipe observes zero failures
// forever — which is exactly what happened. These tests pin both halves of the fix:
// the matcher exists for Claude, and it does NOT leak into clients that have no such
// event (where an unknown event name is at best ignored and at worst a config error).

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildHookConfig,
  buildCursorHookEvents,
  buildCodexHookEvents,
} from "./client-config-writer.js";
import { setHookCommand } from "./hook-command.js";

beforeEach(() => {
  setHookCommand("/tmp/pathrule-hook-test.js");
});

describe("PostToolUseFailure wiring", () => {
  it("registers the matcher in the Claude hook config", () => {
    const config = buildHookConfig();
    const entries = config.hooks.PostToolUseFailure;
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    // Same tools as PostToolUse: these are the failures that name a file worth
    // remembering.
    expect(entries?.[0]?.matcher).toBe("Read|Edit|Write|Bash");
  });

  it("points the matcher at the same hook command as PostToolUse", () => {
    const config = buildHookConfig();
    const post = config.hooks.PostToolUse?.[0]?.hooks?.[0]?.command;
    const fail = config.hooks.PostToolUseFailure?.[0]?.hooks?.[0]?.command;
    expect(fail).toBe(post);
  });

  it("does not leak into the Cursor hook file", () => {
    // Cursor reports failures inside its normal post-tool event. Emitting an event
    // name it does not know would be dead config at best.
    const events = buildCursorHookEvents(buildHookConfig());
    expect(Object.keys(events)).not.toContain("PostToolUseFailure");
    expect(Object.keys(events)).not.toContain("postToolUseFailure");
  });

  it("does not leak into the Codex hook file", () => {
    const events = buildCodexHookEvents(buildHookConfig());
    expect(Object.keys(events)).not.toContain("PostToolUseFailure");
  });
});
