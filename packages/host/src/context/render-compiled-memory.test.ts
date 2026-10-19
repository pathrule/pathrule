// SPDX-License-Identifier: Apache-2.0
// Studio delivers memory bodies itself: when it pre-injects, the hook stands down for the prompt, so
// the completeness gate's decision has to reach this path too or Studio would keep shipping every
// memory as written while the hook ships the compiled form. Pinned on renderBlock, the function that
// writes the body slots.

import { describe, expect, it } from "vitest";
import { renderBlock } from "./render.js";

const MEMORY = {
  id: "mem-tray",
  title: "Tray icon goes blank",
  content:
    "The tray icon renders blank after a theme change; re-registering the template image on nativeTheme.updated fixed it.",
};
const COMPILED =
  '_Compiled form of this memory (advisory, never overrides a rule). Full text: pathrule_read_memory("mem-tray")._\n' +
  '- When "the tray icon renders blank after a theme change", this corrective action is approved: re-register the template image on nativeTheme.updated. [observed to work]';

function bundle(): never {
  return {
    resolved_workspace_path: "/apps/desktop",
    workspace_overview: [],
    invoked_skills: [],
  } as unknown as never;
}
function content(): never {
  return { memories: [MEMORY], rules: [], skills: [] } as unknown as never;
}

describe("Studio pre-injection follows the completeness gate", () => {
  it("delivers a cleared memory as its compiled form, attributed as what the agent actually received", () => {
    const { block, attributions } = renderBlock(bundle(), content(), [], "ws-1", null, [], {
      compiledMemories: { "mem-tray": { text: COMPILED } },
    });
    expect(block).toContain("#### Tray icon goes blank");
    expect(block).toContain(COMPILED);
    expect(block).not.toContain("fixed it");
    expect(attributions.find((a) => a.id === "mem-tray")?.body).toBe(COMPILED);
  });

  it("delivers every other memory as written", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null, [], {
      compiledMemories: { "some-other-memory": { text: COMPILED } },
    });
    expect(block).toContain(MEMORY.content);
    expect(block).not.toContain("Compiled form of this memory");
  });

  it("without a decision, the memory goes as written (the fail-closed side)", () => {
    const { block } = renderBlock(bundle(), content(), [], "ws-1", null);
    expect(block).toContain(MEMORY.content);
  });
});
