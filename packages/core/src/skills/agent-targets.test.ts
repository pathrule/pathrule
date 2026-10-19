// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AGENT_TARGETS,
  filterEffectiveSkillTargets,
  filterSupportedTargets,
} from "./agent-targets.js";

describe("filterSupportedTargets", () => {
  it("keeps every supported target and drops unknown ids", () => {
    const out = filterSupportedTargets(["claude-code", "copilot", "made-up"]);
    expect(out.map((s) => s.id)).toEqual(["claude-code", "copilot"]);
  });

  it("materializes Codex through the cross-engine .agents root and labels the old root", () => {
    expect(AGENT_TARGETS.codex.skillsDir).toBe(".agents/skills");
    expect(AGENT_TARGETS.codex.legacySkillsDirs).toEqual([".codex/skills"]);
  });
});

describe("filterEffectiveSkillTargets", () => {
  it("writes copilot's own skillsDir when copilot is the only active target", () => {
    const out = filterEffectiveSkillTargets(["copilot"]);
    expect(out.map((s) => s.id)).toEqual(["copilot"]);
    expect(out[0]!.skillsDir).toBe(".github/skills");
  });

  it("skips copilot when claude-code is also active (Copilot reads .claude/skills natively)", () => {
    const out = filterEffectiveSkillTargets(["claude-code", "copilot"]);
    expect(out.map((s) => s.id)).toEqual(["claude-code"]);
  });

  it("does not skip copilot for unrelated active targets", () => {
    const out = filterEffectiveSkillTargets(["cursor", "copilot"]);
    expect(out.map((s) => s.id)).toEqual(["cursor", "copilot"]);
  });

  it("never drops a target that nothing satisfies", () => {
    const all = Object.keys(AGENT_TARGETS);
    const out = filterEffectiveSkillTargets(all);
    expect(out.map((s) => s.id)).toEqual(["claude-code", "cursor", "windsurf", "codex"]);
  });
});
