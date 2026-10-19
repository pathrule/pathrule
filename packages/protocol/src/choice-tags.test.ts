// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { CHOICE_TAGS, isChoiceTag } from "./choice-tags.js";

describe("decision-card choice tags", () => {
  // Studio's card instruction lists these tags to the agent, and whatever learns from a pick reads
  // them back: renaming or dropping one silently breaks comparison with every earlier choice.
  it("keeps the closed vocabulary stable", () => {
    expect(CHOICE_TAGS).toEqual([
      "minimal-change",
      "refactor",
      "adds-dependency",
      "reuses-existing",
      "new-abstraction",
      "explicit",
      "performance",
      "simplicity",
      "robustness",
      "security",
      "speed",
      "tests",
      "backward-compatible",
    ]);
  });

  it("accepts only tags from the vocabulary", () => {
    expect(isChoiceTag("refactor")).toBe(true);
    expect(isChoiceTag("Refactor")).toBe(false);
    expect(isChoiceTag("fast")).toBe(false);
    expect(isChoiceTag(undefined)).toBe(false);
    expect(isChoiceTag(3)).toBe(false);
  });
});
