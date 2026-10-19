// SPDX-License-Identifier: Apache-2.0
// The host's rendered turn carries the person's compiled preferences.
//
// The host compiles a turn for every surface that asks it (MCP get_context, the CLI, VS Code), and
// the user layer reaches that turn only through this block. Pinned because the failure is silent:
// every unit test for the layer passes while the rendered turn delivers nothing.

import { describe, expect, it } from "vitest";
import { renderBlock } from "./render.js";

const PREFERENCE_BLOCK = [
  "## How this user prefers to work",
  "Follow these unless a rule, a required verification or a safety boundary says otherwise: those always win.",
  "- The user prefers concise explanations by default. [user context]",
].join("\n");

function bundle(): never {
  return {
    resolved_workspace_path: "/",
    workspace_overview: [],
    invoked_skills: [],
  } as unknown as never;
}
function content(): never {
  return { memories: [], rules: [], skills: [] } as unknown as never;
}

describe("the rendered turn carries User Intelligence", () => {
  it("includes the compiled preference block when there is one", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null, [], {
      userPreferenceBlock: PREFERENCE_BLOCK,
    });
    expect(block).toContain("How this user prefers to work");
    expect(block).toContain("prefers concise explanations");
    expect(block).toContain("[user context]");
  });

  it("keeps the authority sentence, so a preference cannot read as permission", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null, [], {
      userPreferenceBlock: PREFERENCE_BLOCK,
    });
    expect(block).toContain("a required verification or a safety boundary says otherwise");
  });

  it("says nothing when the person has taught Pathrule nothing", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null, [], {
      userPreferenceBlock: "",
    });
    expect(block).not.toContain("How this user prefers to work");
  });

  it("omitting the option entirely is the same as having nothing to say", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null);
    expect(block).not.toContain("How this user prefers to work");
  });
});
