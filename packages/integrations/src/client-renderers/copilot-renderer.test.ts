// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  __resetHookCommandForTests,
  setHookCommand,
} from "../hook-supervisor/hook-command.js";
import { copilotRenderer } from "./copilot-renderer.js";
import type { MultiClientInput, PromotedRulesBundle } from "./types.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

const INPUT: MultiClientInput = {
  workspaceName: "demo",
  overview: [],
};

const PROMOTED: PromotedRulesBundle = {
  workspace_id: "ws-1",
  entries: [
    {
      rule_id: "r-1",
      name: "No em dash",
      display_summary: "Use plain hyphens in app copy.",
      priority: "high",
      scope_type: "project",
      promoted_at: null,
    },
  ],
  signature: "sig-abc",
  rendered_at: "2026-06-07T00:00:00.000Z",
};

describe("copilotRenderer", () => {
  it("emits the three .github files and owns exactly those paths", () => {
    const files = copilotRenderer.render(INPUT);
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([
      ".github/copilot-instructions.md",
      ".github/instructions/pathrule.instructions.md",
      ".github/hooks/pathrule.json",
    ]);
    // ownedPaths must be a superset of everything render can emit.
    const owned = copilotRenderer.ownedPaths(INPUT);
    for (const p of paths) expect(owned).toContain(p);
  });

  it("renders the managed marker + protocol body into the instructions file", () => {
    const [instructions] = copilotRenderer.render(INPUT);
    expect(instructions!.body).toContain("<!-- Pathrule managed");
    expect(instructions!.body).toContain("# Pathrule integration");
    expect(instructions!.body).toContain("GitHub Copilot");
    expect(instructions!.body).toContain("Copilot-specific guardrail");
  });

  it("scoped instructions file carries applyTo frontmatter and points at the main file", () => {
    const files = copilotRenderer.render(INPUT);
    const scoped = files.find((f) => f.path.endsWith(".instructions.md"))!;
    expect(scoped.body.startsWith('---\napplyTo: "**"\n---\n')).toBe(true);
    expect(scoped.body).toContain(".github/copilot-instructions.md");
    expect(scoped.body).toContain("<!-- Pathrule managed");
  });

  it("hooks config is valid camelCase Copilot JSON with env-stamped command entries", () => {
    const files = copilotRenderer.render(INPUT);
    const hooks = JSON.parse(files.find((f) => f.path.endsWith("pathrule.json"))!.body) as {
      version: number;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(hooks.version).toBe(1);
    // userPromptSubmitted must NOT be wired (no context output on Copilot).
    expect(Object.keys(hooks.hooks)).toEqual([
      "sessionStart",
      "preToolUse",
      "postToolUse",
      "agentStop",
      "subagentStop",
      "sessionEnd",
    ]);
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      for (const entry of entries) {
        expect(entry.type).toBe("command");
        expect(typeof entry.command).toBe("string");
        expect(entry.env).toMatchObject({
          PATHRULE_HOOK_CLIENT: "copilot",
          PATHRULE_HOOK_EVENT: event,
        });
      }
    }
    // Tool matchers carry CLI names + VS Code aliases.
    const pre = hooks.hooks.preToolUse![0]!;
    expect(pre.matcher).toContain("view");
    expect(pre.matcher).toContain("edit");
    expect(pre.matcher).toContain("create");
    expect(pre.matcher).toContain("bash");
    expect(pre.matcher).toContain("editFiles");
    expect(pre.matcher).toContain("run_in_terminal");
    // Session lifecycle entries fire on every tool — no matcher.
    expect(hooks.hooks.sessionStart![0]!.matcher).toBeUndefined();
  });

  it("splices the promoted rules section when the bundle is present", () => {
    const [instructions] = copilotRenderer.render({ ...INPUT, promotedRules: PROMOTED });
    expect(instructions!.body).toContain("No em dash");
    expect(instructions!.body).toContain("sig-abc");
  });
});
