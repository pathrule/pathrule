// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { buildDiscoverySignal } from "../lib/discovery-signal.js";

const base = {
  matchedNodePath: "/apps/mobile",
  directMemoryCount: 0,
  subtreeBudget: 8,
  truncated: false,
  ancestorsWalked: false,
};

describe("buildDiscoverySignal", () => {
  it("keeps subtree title matches ahead of semantic advice", () => {
    const signal = buildDiscoverySignal({
      ...base,
      subtreeIndex: [
        {
          id: "mem-subtree",
          title: "layout.json Schema",
          node_path: "/apps/mobile/brands",
        },
      ],
      semanticCandidates: [{ confidence: "high" }],
    });

    expect(signal?.recommendation).toBe("answer_from_subtree_titles");
    expect(signal?.candidate_memory_titles?.[0]?.id).toBe("mem-subtree");
    expect(signal?.semantic_high_confidence_count).toBe(1);
  });

  it("recommends inspecting high-confidence semantic candidates when no lexical surface exists", () => {
    const signal = buildDiscoverySignal({
      ...base,
      semanticCandidates: [{ confidence: "high" }, { confidence: "medium" }],
    });

    expect(signal?.recommendation).toBe("inspect_semantic_candidates");
    expect(signal?.semantic_candidates_count).toBe(2);
    expect(signal?.semantic_high_confidence_count).toBe(1);
    expect(signal?.semantic_instruction).toContain("pathrule_read_memory");
  });

  it("marks medium-only semantic evidence as low confidence", () => {
    const signal = buildDiscoverySignal({
      ...base,
      semanticCandidates: [{ confidence: "medium" }],
    });

    expect(signal?.recommendation).toBe("low_semantic_confidence");
    expect(signal?.semantic_candidates_count).toBe(1);
    expect(signal?.semantic_high_confidence_count).toBeUndefined();
  });

  it("does not emit discovery advice when direct memories are already present", () => {
    const signal = buildDiscoverySignal({
      ...base,
      directMemoryCount: 1,
      semanticCandidates: [{ confidence: "high" }],
    });

    expect(signal).toBeUndefined();
  });
});
