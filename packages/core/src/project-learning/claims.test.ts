// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  learningClaimBytes,
  parseLearningClaim,
  requireWritableLearningClaim,
  type LearningClaim,
} from "./claims.js";
import { createLearningClaim } from "./claim-service.js";

const claim: LearningClaim = {
  version: 1,
  id: "a".repeat(64),
  workspaceId: "ws",
  nodePath: "/src",
  topic: "Storage",
  statement: "Current storage boundary.",
  category: "architecture",
  origin: "agent_synthesis",
  sources: [{ path: "src/store.ts", digest: `sha256:${"b".repeat(64)}` }],
};

describe("learning claim wire limits", () => {
  it("counts JSONB separator whitespace, escaped controls and UTF-8, including emoji", () => {
    const input = { ...claim, statement: 'Türkçe 界 🌍 "quote"\n\t\\' };
    const compact = JSON.stringify(input);
    // Nine top-level properties, two source properties: eleven colons and nine commas.
    expect(learningClaimBytes(input)).toBe(Buffer.byteLength(compact) + 20);
    expect(requireWritableLearningClaim(input)).toEqual(input);
  });

  it("accepts exactly 12000 bytes and rejects 12001 before a new claim can be created", () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({
      path: `src/${"界".repeat(450)}${i}.ts`,
      digest: `sha256:${"b".repeat(64)}`,
    }));
    let exact: LearningClaim | undefined;
    for (let chars = 0; chars <= 1200; chars++) {
      const candidate = { ...claim, sources, statement: "界".repeat(chars) };
      const padding = 12000 - learningClaimBytes(candidate);
      if (padding >= 0 && chars + padding < 1200) {
        exact = { ...candidate, statement: candidate.statement + "a".repeat(padding) };
        break;
      }
    }
    expect(exact).toBeDefined();
    expect(learningClaimBytes(exact!)).toBe(12000);
    expect(requireWritableLearningClaim(exact!)).toEqual(exact);
    const tooLarge = { ...exact!, statement: exact!.statement + "a" };
    expect(() => requireWritableLearningClaim(tooLarge)).toThrow("12001 bytes");
    expect(() => createLearningClaim(tooLarge)).toThrow("12001 bytes");
    // Previously persisted user work remains readable for correction or export.
    expect(parseLearningClaim(tooLarge)).toEqual(tooLarge);
  });

  it.each(["\u0000", "\ud800", "\udc00"])("rejects JSONB-incompatible text %j", (text) => {
    expect(() => requireWritableLearningClaim({ ...claim, statement: `text${text}` })).toThrow(
      "unsupported",
    );
  });
});
