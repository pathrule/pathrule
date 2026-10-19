// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { PATHRULE_REGION, hasRegion, spliceRegion, stripRegion } from "@pathrule/core";

const USER = `# Acme Platform

See @docs/architecture.md for the service map.

## Conventions
Use camelCase.
`;

describe("spliceRegion", () => {
  it("appends the region to a user file without touching their content", () => {
    const out = spliceRegion(USER, "PATHRULE BODY");
    expect(out.startsWith(USER.trimEnd())).toBe(true);
    expect(out).toContain("PATHRULE BODY");
    expect(hasRegion(out)).toBe(true);
  });

  it("replaces the region on re-render, leaving user content byte-identical", () => {
    const first = spliceRegion(USER, "VERSION ONE");
    const second = spliceRegion(first, "VERSION TWO");

    expect(second).toContain("VERSION TWO");
    expect(second).not.toContain("VERSION ONE");
    expect(stripRegion(second)).toBe(USER.trim());
  });

  it("is idempotent: same section twice produces identical bytes", () => {
    const once = spliceRegion(USER, "BODY");
    expect(spliceRegion(once, "BODY")).toBe(once);
  });

  it("preserves user content that follows the region", () => {
    const withTrailer = `${spliceRegion(USER, "OLDSECTION").trimEnd()}\n\n## My own footer\nKeep me.\n`;
    const next = spliceRegion(withTrailer, "FRESHSECTION");
    expect(next).toContain("## My own footer");
    expect(next).toContain("Keep me.");
    expect(next).toContain("FRESHSECTION");
    expect(next).not.toContain("OLDSECTION");
    // The footer stays AFTER the region, i.e. ordering is preserved.
    expect(next.indexOf("## My own footer")).toBeGreaterThan(next.indexOf(PATHRULE_REGION.end));
  });

  it("recovers when the end anchor was deleted", () => {
    const broken = `${USER}\n${PATHRULE_REGION.begin}\nhalf written`;
    const fixed = spliceRegion(broken, "REPAIRED");
    expect(hasRegion(fixed)).toBe(true);
    expect(fixed).toContain("REPAIRED");
    expect(fixed).not.toContain("half written");
    expect(fixed).toContain("Use camelCase.");
  });

  it("writes a standalone region into an empty file", () => {
    const out = spliceRegion("", "ONLY PATHRULE");
    expect(hasRegion(out)).toBe(true);
    expect(stripRegion(out)).toBe("");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("always ends with exactly one newline", () => {
    for (const input of ["", USER, `${USER}\n\n\n`]) {
      const out = spliceRegion(input, "BODY");
      expect(out.endsWith("\n")).toBe(true);
      expect(out.endsWith("\n\n")).toBe(false);
    }
  });
});

describe("hasRegion", () => {
  it("is false for a plain user file and true after splicing", () => {
    expect(hasRegion(USER)).toBe(false);
    expect(hasRegion(spliceRegion(USER, "x"))).toBe(true);
  });

  it("is false when only the begin anchor survives", () => {
    expect(hasRegion(`${USER}\n${PATHRULE_REGION.begin}\ntruncated`)).toBe(false);
  });
});

describe("stripRegion", () => {
  it("returns the user's content only", () => {
    expect(stripRegion(spliceRegion(USER, "PATHRULE"))).toBe(USER.trim());
  });

  it("returns the input unchanged when there is no region", () => {
    expect(stripRegion(USER)).toBe(USER);
  });
});
