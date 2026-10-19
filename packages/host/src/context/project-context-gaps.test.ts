// SPDX-License-Identifier: Apache-2.0
// Open knowledge gaps in a turn's project context: at most two, each once per conversation, and
// never past the block's ceiling.
import type { KnowledgeBackend } from "@pathrule/core";
import type { KnowledgeGapStub } from "@pathrule/protocol/hook-index.js";
import { KNOWLEDGE_GAP_HEADER } from "@pathrule/core/knowledge-map/gap-delivery.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnContext } from "@pathrule/protocol/turn-context.js";
import {
  clearProjectLearningCache,
  composeWithProjectLearning,
  type ProjectLearningDeps,
} from "./project-context.js";

const gap = (scope: string): KnowledgeGapStub => ({
  ref: `gap_${scope.length}`,
  scope,
  line: `nothing recorded references ${scope}.`,
});

const base: TurnContext = {
  block: "",
  stableBlock: "STABLE",
  dynamicBlock: "DYNAMIC",
  stableVersion: "v1",
  itemVersions: [],
  metrics: {
    stableChars: 6,
    dynamicChars: 7,
    totalChars: 13,
    deliveredItems: 0,
    omittedKnownItems: 0,
  },
  attributions: [],
};

function compose(
  gaps: KnowledgeGapStub[],
  options: { known?: string[]; maxChars?: number; scope?: string } = {},
) {
  const loadKnowledgeGaps = vi.fn(async () => gaps);
  const deps: ProjectLearningDeps = {
    loadLearningContext: async () => null as never,
    loadProjectMap: async () => null as never,
    readLearningStamp: async () => "stamp",
    loadKnowledgeGaps,
    projectContextBudgetMs: 5_000,
  };
  const run = composeWithProjectLearning({
    deps,
    backend: {} as KnowledgeBackend,
    workspaceId: "ws",
    localRootPath: "/repo",
    scope: options.scope ?? "/packages/cli",
    routeDepth: "focused",
    retrievalMode: "lexical",
    baseResult: base,
    retrieval: { delta: "", version: "" },
    intelligenceBlock: "",
    surface: "chat",
    knownItemVersions: options.known,
    maxChars: options.maxChars ?? 40_000,
    truncate: (text, max) => text.slice(0, max),
  });
  return { run, loadKnowledgeGaps };
}

describe("Studio turn-zero knowledge gaps", () => {
  beforeEach(() => clearProjectLearningCache());

  it("names at most two gaps under the advisory header, and versions each", async () => {
    const gaps = [gap("packages/cli/src"), gap("packages/cli/src/commands"), gap("packages/cli")];
    const { run, loadKnowledgeGaps } = compose(gaps);
    const { result } = await run;
    expect(loadKnowledgeGaps).toHaveBeenCalledWith({
      backend: {},
      workspaceId: "ws",
      workspaceRoot: "/repo",
      scope: "/packages/cli",
    });
    expect(result.dynamicBlock).toBe(
      [
        "DYNAMIC",
        [KNOWLEDGE_GAP_HEADER, `- ${gaps[0]!.line}`, `- ${gaps[1]!.line}`].join("\n"),
      ].join("\n\n"),
    );
    expect(result.itemVersions).toEqual([
      `knowledge-gap:${gaps[0]!.ref}:1`,
      `knowledge-gap:${gaps[1]!.ref}:1`,
    ]);
    expect(result.metrics.deliveredItems).toBe(2);
  });

  it("never names a gap twice in one conversation", async () => {
    const gaps = [gap("packages/cli/src"), gap("packages/cli")];
    const { result } = await compose(gaps, { known: [`knowledge-gap:${gaps[0]!.ref}:1`] }).run;
    expect(result.dynamicBlock).not.toContain(gaps[0]!.line);
    expect(result.dynamicBlock).toContain(gaps[1]!.line);
    clearProjectLearningCache();
    const known = gaps.map((g) => `knowledge-gap:${g.ref}:1`);
    expect((await compose(gaps, { known }).run).result.dynamicBlock).toBe("DYNAMIC");
  });

  it("drops the gap lines rather than extend the block ceiling, and adds nothing at the root", async () => {
    const gaps = [gap("packages/cli/src")];
    const tight = await compose(gaps, { maxChars: 40 }).run;
    expect(tight.result.dynamicBlock).toBe("DYNAMIC");
    expect(tight.result.itemVersions).toEqual([]);
    clearProjectLearningCache();
    expect((await compose(gaps, { scope: "/" }).run).result.dynamicBlock).toBe("DYNAMIC");
  });
});
