// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { previewPattern, joinPatternPaths, patternProvenanceTag } from "./import-pattern.js";

describe("pattern import preview + path re-rooting", () => {
  it("joinPatternPaths re-roots under a base, leaving '/' as the base itself", () => {
    expect(joinPatternPaths(undefined, "/app")).toBe("/app");
    expect(joinPatternPaths("/", "/app")).toBe("/app");
    expect(joinPatternPaths("/apps/mobile", "/app")).toBe("/apps/mobile/app");
    expect(joinPatternPaths("/apps/mobile", "/")).toBe("/apps/mobile");
    expect(joinPatternPaths("/apps/mobile/", "app")).toBe("/apps/mobile/app");
  });

  it("patternProvenanceTag stamps a findable group tag", () => {
    expect(patternProvenanceTag("expo-react-native")).toBe("pattern:expo-react-native");
  });

  it("dry-run preview returns appliesTo + pieces with resolved paths, no writes", () => {
    const res = previewPattern("expo-react-native", "/apps/mobile");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.slug).toBe("expo-react-native");
    expect(res.data.appliesTo?.stacks).toContain("expo");
    expect(res.data.pieces.length).toBeGreaterThan(0);
    // every declared "/app" piece is re-rooted under the chosen base
    for (const p of res.data.pieces) {
      expect(p.path.startsWith("/apps/mobile")).toBe(true);
    }
  });

  it("preview of an unknown slug fails cleanly (not_found), never throws", () => {
    const res = previewPattern("definitely-not-a-real-pattern");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("not_found");
  });
});
