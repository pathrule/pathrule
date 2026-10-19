// SPDX-License-Identifier: Apache-2.0
// Token-cost guard for the plan-author skill. Enforces the core value
// proposition: the milestone-plan-author skill costs one orientation line (name +
// description) when merely AVAILABLE, and its full body enters context ONLY when invoked
// via ::name, capped at MAX_SKILL_CHARS. A regression here silently re-caches the whole
// template every turn, which is exactly what the milestone set out to prevent.
//
// The invoked body is a hard gate: it must ride the context itself. Routing it through a
// read the model may skip (or an MCP server that is not connected) loses the instruction.

import { describe, expect, it } from "vitest";

import { renderBlock } from "./render.js";

const MAX_SKILL_CHARS = 4_000;
const HUGE_BODY = "X".repeat(9_000);

const SKILL = {
  id: "skill-1",
  name: "milestone-plan-author",
  description: "Write new Pathrule milestone implementation plans.",
  content: HUGE_BODY,
};

// renderBlock reads a small, well-defined slice of these shapes; cast minimal fixtures.
function bundle(invoked: Array<{ id: string; name: string; content: string }>): never {
  return {
    invoked_skills: invoked,
    workspace_overview: [],
    resolved_workspace_path: "/",
    node: null,
  } as unknown as never;
}

function nodeContent(skills: Array<{ id: string; name: string; description: string }>): never {
  return { memories: [], rules: [], skills } as unknown as never;
}

describe("plan-author skill token cost", () => {
  it("contributes only name + description when available (no body)", () => {
    const { block } = renderBlock(bundle([]), nodeContent([SKILL]), [], "ws-1", null);
    expect(block).toContain(
      "milestone-plan-author: Write new Pathrule milestone implementation plans.",
    );
    // The 9k body must NOT leak into an available-skill listing.
    expect(block).not.toContain(HUGE_BODY);
    expect((block.match(/X/g) ?? []).length).toBe(0);
  });

  it("injects the body once, capped at MAX_SKILL_CHARS, only when invoked", () => {
    const { block, attributions } = renderBlock(
      bundle([{ id: SKILL.id, name: SKILL.name, content: SKILL.content }]),
      nodeContent([]),
      [],
      "ws-1",
      null,
    );
    expect(block).toContain("### Invoked skills");
    const xCount = (block.match(/X/g) ?? []).length;
    expect(xCount).toBeGreaterThan(0);
    expect(xCount).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    expect(xCount).toBeLessThan(HUGE_BODY.length);
    // The invocation is attributed, so the transcript can show it as a named skill row
    // the user can open, instead of the body appearing in the answer.
    expect(attributions).toContainEqual(
      expect.objectContaining({
        kind: "skill",
        id: SKILL.id,
        title: SKILL.name,
        source: "injected",
      }),
    );
  });
});
