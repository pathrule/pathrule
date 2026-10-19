// SPDX-License-Identifier: Apache-2.0
/**
 * The single source of Pathrule's design tokens.
 *
 * `styles/tokens.css` is generated from this file (`pnpm --filter @pathrule/ui tokens`)
 * and a test fails when the two drift. Components read the CSS custom properties;
 * TypeScript consumers (charts, canvas, tests) read this object.
 *
 * Neutrals carry a faint green cast inherited from the accent so the system reads
 * as one material. Accent means "primary action" and "verified": never use it for
 * observations, hypotheses or untrusted runtime data.
 *
 * Positive is an observation that moved the right way (a rising metric, a healthy
 * check). It sits close to the accent's hue by nature, so it never carries meaning
 * alone: pair it with an arrow or icon and a signed value or a word.
 *
 * The `viz` roles are the categorical chart palette, in a fixed order that keeps
 * adjacent series apart for color-vision deficiencies (OKLab ΔE ≥ 8, validated on
 * `--pr-bg-1` in both themes). Assign them in order, never cycled; past three series in
 * an all-pairs chart (scatter, small multiples) fold into "Other". In light mode slots
 * 3 to 5 sit under 3:1 on the surface: those charts need direct labels or a table view.
 */

export type ThemeName = "dark" | "light";
export type DensityName = "comfortable" | "compact";

export interface ColorRole {
  /** Runtime name, e.g. `--pr-bg-1`. Prefixed so the library never collides with a host app's variables. */
  readonly cssVar: `--${string}`;
  /** Token path, e.g. `color.bg.surface`. */
  readonly path: string;
  /** What the role is for. */
  readonly role: string;
  readonly dark: string;
  readonly light: string;
  readonly group: "surface" | "border" | "text" | "accent" | "status" | "inverse" | "viz";
}

const c = (
  cssVar: `--${string}`,
  path: string,
  role: string,
  dark: string,
  light: string,
  group: ColorRole["group"],
): ColorRole => ({ cssVar, path, role, dark, light, group });

export const colors = [
  c("--pr-bg", "color.bg.canvas", "App canvas", "#070807", "#f6f7f5", "surface"),
  c("--pr-bg-1", "color.bg.surface", "Cards, panels, inputs", "#151815", "#ffffff", "surface"),
  c("--pr-bg-2", "color.bg.subtle", "Row hover, wells, code", "#1c201c", "#f0f2ef", "surface"),
  c("--pr-bg-3", "color.bg.selected", "Selected nav, pressed", "#252a25", "#e6e9e5", "surface"),
  c(
    "--pr-bg-inset",
    "color.bg.inset",
    "Terminals, untrusted payloads",
    "#050605",
    "#eceeea",
    "surface",
  ),
  c(
    "--pr-line-1",
    "color.border.subtle",
    "Dividers inside a surface",
    "#212521",
    "#e7eae6",
    "border",
  ),
  c("--pr-line-2", "color.border.default", "Cards, controls", "#2d322d", "#d9ded7", "border"),
  c("--pr-line-3", "color.border.strong", "Hover, emphasis", "#3e443e", "#bfc6bd", "border"),
  c("--pr-fg-1", "color.text.primary", "Headings, values", "#eceeea", "#0c0e0c", "text"),
  c("--pr-fg-2", "color.text.secondary", "Body copy", "#b4b7b1", "#363a35", "text"),
  c("--pr-fg-3", "color.text.tertiary", "Descriptions, labels", "#8d918b", "#575c56", "text"),
  c("--pr-fg-4", "color.text.meta", "Mono captions, timestamps", "#858a83", "#646963", "text"),
  c(
    "--pr-accent",
    "color.accent.solid",
    "Primary action, verified",
    "#3ee29d",
    "#0b7f4f",
    "accent",
  ),
  c("--pr-accent-hover", "color.accent.hover", "Primary hover", "#64edb4", "#086b42", "accent"),
  c("--pr-accent-fg", "color.accent.on", "Text on accent", "#04140c", "#ffffff", "accent"),
  c(
    "--pr-accent-text",
    "color.accent.text",
    "Accent text and icons",
    "#3ee29d",
    "#0a7347",
    "accent",
  ),
  c("--pr-accent-soft", "color.accent.soft", "Verified background", "#142a1f", "#e7f5ee", "accent"),
  c("--pr-accent-line", "color.accent.border", "Verified border", "#1f3a2c", "#b3dec8", "accent"),
  c("--pr-warn", "color.status.warning", "Hypotheses, plan limits", "#e8b64c", "#8f5f00", "status"),
  c(
    "--pr-warn-soft",
    "color.status.warning-soft",
    "Warning background",
    "#2a2110",
    "#fbf3e1",
    "status",
  ),
  c(
    "--pr-warn-line",
    "color.status.warning-border",
    "Warning border",
    "#3b2f15",
    "#ead39f",
    "status",
  ),
  c(
    "--pr-danger",
    "color.status.danger",
    "Errors, destructive, recurred",
    "#ff7a6e",
    "#b8321f",
    "status",
  ),
  c(
    "--pr-danger-soft",
    "color.status.danger-soft",
    "Danger background",
    "#2e1814",
    "#fcebe8",
    "status",
  ),
  c(
    "--pr-danger-line",
    "color.status.danger-border",
    "Danger border",
    "#4a1f1a",
    "#efc0b8",
    "status",
  ),
  c("--pr-info", "color.status.info", "Observing, informational", "#82b6ff", "#2457b8", "status"),
  c("--pr-info-soft", "color.status.info-soft", "Info background", "#132036", "#e9f0fc", "status"),
  c("--pr-info-line", "color.status.info-border", "Info border", "#1e3050", "#bdd0f2", "status"),
  c(
    "--pr-positive",
    "color.status.positive",
    "Improvement, healthy observation",
    "#9cd67a",
    "#2b6e14",
    "status",
  ),
  c(
    "--pr-positive-soft",
    "color.status.positive-soft",
    "Positive background",
    "#18241a",
    "#edf5e6",
    "status",
  ),
  c(
    "--pr-positive-line",
    "color.status.positive-border",
    "Positive border",
    "#2a3d24",
    "#c3dcb0",
    "status",
  ),
  c("--pr-viz-1", "color.viz.1", "Chart series 1 (blue)", "#3987e5", "#2a78d6", "viz"),
  c("--pr-viz-2", "color.viz.2", "Chart series 2 (orange)", "#d95926", "#eb6834", "viz"),
  c("--pr-viz-3", "color.viz.3", "Chart series 3 (aqua)", "#199e70", "#1baf7a", "viz"),
  c("--pr-viz-4", "color.viz.4", "Chart series 4 (yellow)", "#c98500", "#eda100", "viz"),
  c("--pr-viz-5", "color.viz.5", "Chart series 5 (magenta)", "#d55181", "#e87ba4", "viz"),
  c("--pr-inv-bg", "color.bg.inverse", "Tooltips, emphasis pill", "#eceeea", "#0c0e0c", "inverse"),
  c("--pr-inv-fg", "color.text.inverse", "Text on inverse", "#070807", "#f6f7f5", "inverse"),
] as const satisfies readonly ColorRole[];

/** Composite theme values that are not a single color role. */
export const themeExtras: Record<ThemeName, Record<`--${string}`, string>> = {
  dark: {
    "--pr-focus": "0 0 0 2px #070807, 0 0 0 4px #3ee29d",
    "--pr-shadow-pop": "0 16px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px #363c36",
    "--pr-scrim": "rgba(3, 4, 3, 0.72)",
  },
  light: {
    "--pr-focus": "0 0 0 2px #ffffff, 0 0 0 4px #0b7f4f",
    "--pr-shadow-pop": "0 16px 48px rgba(20, 30, 20, 0.14), 0 0 0 1px #d9ded7",
    "--pr-scrim": "rgba(20, 24, 20, 0.32)",
  },
};

/** Control heights, row height, padding and base font size per density, in px. */
export const density: Record<
  DensityName,
  Record<"h-sm" | "h" | "h-lg" | "row" | "px" | "gap" | "fs", number>
> = {
  comfortable: { "h-sm": 28, h: 34, "h-lg": 40, row: 44, px: 12, gap: 12, fs: 14 },
  compact: { "h-sm": 24, h: 28, "h-lg": 34, row: 32, px: 10, gap: 8, fs: 13 },
};

export const fonts = {
  sans: "'Geist', 'Geist Variable', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const;

/** 4px grid. Keys follow `space.{n}` where n * 4 = px. */
export const space = {
  "0-5": 2,
  "1": 4,
  "1-5": 6,
  "2": 8,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
  "8": 32,
  "11": 44,
  "16": 64,
} as const;

export const radius = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;

export const zIndex = {
  base: 0,
  sticky: 20,
  nav: 30,
  dropdown: 40,
  drawer: 50,
  dialog: 60,
  /** Popovers and menus are portalled to the body, so one opened inside a dialog must sit above it. */
  popover: 65,
  toast: 70,
  tooltip: 80,
} as const;

/** Lower bounds in px: xs < 600 <= sm < 900 <= md < 1280 <= lg. */
export const breakpoints = { sm: 600, md: 900, lg: 1280 } as const;

/**
 * Page widths in px. Content is centered and never grows past `content`, so a very wide screen
 * adds margin, not line length; `narrow` is for forms and settings. The gutter scales between
 * its bounds with the viewport.
 */
export const layout = { content: 1296, narrow: 880, "gutter-min": 16, "gutter-max": 40 } as const;

export const motion = {
  duration: { "1": 120, "2": 200, "3": 320, "4": 600 },
  ease: {
    standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    exit: "cubic-bezier(0.4, 0, 1, 1)",
    emphasized: "cubic-bezier(0.7, 0, 0.2, 1)",
  },
} as const;

export interface TypeStyle {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: 400 | 500 | 600;
  readonly tracking: string;
  readonly family: "sans" | "mono";
  readonly numeric?: "tabular-nums";
}

export const typography = {
  display: { size: 44, lineHeight: 1, weight: 500, tracking: "-0.045em", family: "sans" },
  "title-1": { size: 28, lineHeight: 1.15, weight: 500, tracking: "-0.03em", family: "sans" },
  "title-2": { size: 20, lineHeight: 1.3, weight: 500, tracking: "-0.02em", family: "sans" },
  "title-3": { size: 15, lineHeight: 1.35, weight: 500, tracking: "-0.01em", family: "sans" },
  body: { size: 14, lineHeight: 1.5, weight: 400, tracking: "0", family: "sans" },
  "body-sm": { size: 13, lineHeight: 1.45, weight: 400, tracking: "0", family: "sans" },
  label: { size: 12.5, lineHeight: 1.3, weight: 500, tracking: "0", family: "sans" },
  "caption-mono": { size: 11, lineHeight: 1.3, weight: 400, tracking: "0", family: "mono" },
  code: { size: 12.5, lineHeight: 1.7, weight: 400, tracking: "0", family: "mono" },
  numeric: {
    size: 20,
    lineHeight: 1.2,
    weight: 500,
    tracking: "-0.02em",
    family: "sans",
    numeric: "tabular-nums",
  },
} as const satisfies Record<string, TypeStyle>;

export type TypeStyleName = keyof typeof typography;

export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20 } as const;

/** px → rem at the browser default 16px, so user font-size preferences scale the UI. */
export function rem(px: number): string {
  if (px === 0) return "0";
  const value = Math.round((px / 16) * 10000) / 10000;
  return `${value}rem`;
}

/** Hex value of a color role in a theme, for canvas/chart code that cannot read CSS. */
export function colorValue(cssVar: (typeof colors)[number]["cssVar"], theme: ThemeName): string {
  const role = colors.find((entry) => entry.cssVar === cssVar);
  if (!role) throw new Error(`Unknown color role ${cssVar}`);
  return role[theme];
}
