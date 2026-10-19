// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  rankByPromptSimilarity,
  SEMANTIC_INJECT_MIN,
  SEMANTIC_INJECT_TOPK,
} from "./semantic-rank.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal, 0 for a zero vector", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("clamps a non-finite element to 0 (corrupt stored vector never out-ranks)", () => {
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0);
  });
});

describe("rankByPromptSimilarity (top-k relevance gate)", () => {
  const prompt = [1, 0, 0];

  it("returns top-k above threshold, score-descending", () => {
    const out = rankByPromptSimilarity({
      promptVec: prompt,
      items: [
        { id: "a", vec: [1, 0, 0] }, // cos 1.0
        { id: "b", vec: [0.9, 0.1, 0] }, // high
        { id: "c", vec: [0, 1, 0] }, // cos 0 → dropped
        { id: "d", vec: [0.8, 0.6, 0] }, // ~0.8
      ],
      topK: 2,
    });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
  });

  it("drops everything below minCosine (abstain over weak match)", () => {
    const out = rankByPromptSimilarity({
      promptVec: prompt,
      items: [{ id: "x", vec: [0.3, 0.954, 0] }], // cosine ~0.30 < 0.45 floor
      minCosine: SEMANTIC_INJECT_MIN,
    });
    expect(out).toEqual([]);
  });

  it("DETERMINISTIC tie-break by id (cache-stability)", () => {
    const items = [
      { id: "zeta", vec: [1, 0, 0] },
      { id: "alpha", vec: [1, 0, 0] },
      { id: "mid", vec: [1, 0, 0] },
    ];
    const a = rankByPromptSimilarity({ promptVec: prompt, items, topK: 3 });
    const b = rankByPromptSimilarity({ promptVec: prompt, items: [...items].reverse(), topK: 3 });
    expect(a.map((r) => r.id)).toEqual(["alpha", "mid", "zeta"]);
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id)); // input order irrelevant
  });

  it("defaults to SEMANTIC_INJECT_TOPK and skips malformed items", () => {
    // More valid candidates than the default top-k so the cap is what trims,
    // not a shortage of items; the two malformed entries are skipped silently.
    const items = [
      ...Array.from({ length: SEMANTIC_INJECT_TOPK + 2 }, (_, i) => ({
        id: `m${i}`,
        vec: [1 - i * 0.001, i * 0.001, 0],
      })),
      // malformed — skipped, never throws
      { id: "", vec: [1, 0, 0] } as { id: string; vec: number[] },
      { id: "e" } as unknown as { id: string; vec: number[] },
    ];
    const out = rankByPromptSimilarity({ promptVec: prompt, items });
    expect(out).toHaveLength(SEMANTIC_INJECT_TOPK);
  });

  it("empty items / topK 0 yields empty", () => {
    expect(rankByPromptSimilarity({ promptVec: prompt, items: [] })).toEqual([]);
    expect(
      rankByPromptSimilarity({ promptVec: prompt, items: [{ id: "a", vec: [1, 0, 0] }], topK: 0 }),
    ).toEqual([]);
  });
});
