// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderTokensCss } from "../src/tokens/css.js";
import { colorValue, colors, rem, zIndex, type ThemeName } from "../src/tokens/tokens.js";

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

type Role = (typeof colors)[number]["cssVar"];

describe("tokens", () => {
  it("the committed tokens.css is generated from tokens.ts", () => {
    const file = readFileSync(
      fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
      "utf8",
    );
    expect(file).toBe(renderTokensCss());
  });

  it("every variable is prefixed so the library cannot collide with a host app", () => {
    for (const match of renderTokensCss().matchAll(/^\s+(--[\w-]+):/gm))
      expect(match[1]).toMatch(/^--pr-/);
  });

  it("layers popovers and menus above dialogs and drawers, since they open from inside them", () => {
    expect(zIndex.popover).toBeGreaterThan(zIndex.dialog);
    expect(zIndex.popover).toBeGreaterThan(zIndex.drawer);
    expect(zIndex.popover).toBeLessThan(zIndex.toast);
    const css = readFileSync(
      fileURLToPath(new URL("../src/styles/components.css", import.meta.url)),
      "utf8",
    );
    expect(css).toMatch(/\.pr-popover,\s*\.pr-menu\s*{\s*z-index: var\(--pr-z-popover\)/);
  });

  it("converts px to rem so user font-size preferences scale the UI", () => {
    expect(rem(16)).toBe("1rem");
    expect(rem(14)).toBe("0.875rem");
    expect(rem(0)).toBe("0");
  });

  const themes: ThemeName[] = ["dark", "light"];
  // The pairs the playground's contrast table promises at AA (4.5:1) or better.
  const pairs: Array<[Role, Role, string]> = [
    ["--pr-fg-1", "--pr-bg", "primary text on canvas"],
    ["--pr-fg-2", "--pr-bg-1", "body on surface"],
    ["--pr-fg-3", "--pr-bg-1", "description on surface"],
    ["--pr-fg-4", "--pr-bg-1", "meta caption on surface"],
    ["--pr-fg-4", "--pr-bg-2", "meta on subtle row"],
    ["--pr-accent-fg", "--pr-accent", "label on primary button"],
    ["--pr-accent-text", "--pr-bg-1", "accent text on surface"],
    ["--pr-accent-text", "--pr-accent-soft", "verified label on soft"],
    ["--pr-warn", "--pr-warn-soft", "hypothesis label"],
    ["--pr-danger", "--pr-danger-soft", "error message"],
    ["--pr-info", "--pr-info-soft", "observing label"],
    ["--pr-positive", "--pr-bg-1", "improvement on surface"],
    ["--pr-positive", "--pr-positive-soft", "improvement label on soft"],
    ["--pr-inv-fg", "--pr-inv-bg", "tooltip"],
  ];
  // Chart marks are graphics, not text: 3:1 on the surface in dark mode. Light mode
  // slots 3 to 5 rely on direct labels or a table view, as the palette's note says.
  const viz: Role[] = ["--pr-viz-1", "--pr-viz-2", "--pr-viz-3", "--pr-viz-4", "--pr-viz-5"];
  for (const role of viz) {
    it(`dark: ${role} reads as a graphic on the surface (3:1)`, () => {
      expect(
        contrast(colorValue(role, "dark"), colorValue("--pr-bg-1", "dark")),
      ).toBeGreaterThanOrEqual(3);
    });
  }
  for (const role of viz.slice(0, 2)) {
    it(`light: ${role} reads as a graphic on the surface (3:1)`, () => {
      expect(
        contrast(colorValue(role, "light"), colorValue("--pr-bg-1", "light")),
      ).toBeGreaterThanOrEqual(3);
    });
  }

  for (const theme of themes) {
    for (const [fg, bg, what] of pairs) {
      it(`${theme}: ${what} (${fg} on ${bg}) meets 4.5:1`, () => {
        expect(contrast(colorValue(fg, theme), colorValue(bg, theme))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
