// SPDX-License-Identifier: Apache-2.0
// The storage clamps tolerate a malformed files map: a log must land in one call.

import { describe, it, expect } from "vitest";
import { MAX_FILES_TOUCHED, clampFilesTouched } from "./activity-log.js";

describe("clampFilesTouched tolerance", () => {
  it("coerces undefined/null to an empty map without throwing", () => {
    expect(clampFilesTouched(undefined)).toEqual({ total: 0, by_area: {} });
    expect(clampFilesTouched(null)).toEqual({ total: 0, by_area: {} });
  });

  it("tolerates a missing or non-object by_area", () => {
    expect(clampFilesTouched({ total: 5 } as never)).toEqual({ total: 0, by_area: {} });
    expect(clampFilesTouched({ total: 5, by_area: "oops" } as never)).toEqual({
      total: 0,
      by_area: {},
    });
  });

  it("skips non-array areas and non-string paths instead of throwing", () => {
    const out = clampFilesTouched({
      total: 9,
      by_area: { a: "not-array", b: ["x.ts", 42, "y.ts"] },
    } as never);
    expect(out.by_area).toEqual({ b: ["x.ts", "y.ts"] });
    expect(out.total).toBe(2);
  });

  it("keeps a valid payload and recomputes total", () => {
    const out = clampFilesTouched({ total: 99, by_area: { ui: ["a.tsx", "b.tsx"] } });
    expect(out).toEqual({ total: 2, by_area: { ui: ["a.tsx", "b.tsx"] } });
  });

  it("caps the total number of stored paths at MAX_FILES_TOUCHED", () => {
    const many = Array.from({ length: MAX_FILES_TOUCHED + 20 }, (_, i) => `f${i}.ts`);
    const out = clampFilesTouched({ total: many.length, by_area: { core: many } });
    expect(out.total).toBe(MAX_FILES_TOUCHED);
  });
});
