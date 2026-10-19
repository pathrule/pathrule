// SPDX-License-Identifier: Apache-2.0
// The terminal experience's visual language: Pathrule's palette (./theme.ts) at the depth the
// terminal draws, bold for what matters, a quieter grey for what a person can do without, and
// box-drawing for panels and the setup rail. Every glyph has an ASCII twin, and without colour every
// style is the text itself (a selected item is bracketed instead of highlighted). Nothing animates.
import type { TerminalProfile } from "./profile.js";
import { palette, type ColorDepth, type Tone } from "./theme.js";

export interface Glyphs {
  brand: string;
  pointer: string;
  ok: string;
  warn: string;
  error: string;
  pending: string;
  off: string;
  dot: string;
  bullet: string;
  rule: string;
  arrow: string;
  ellipsis: string;
  check: string;
  uncheck: string;
  /** A connected or live thing. */
  live: string;
  /** Panel corners and sides. */
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  /** The setup rail: its start, its line, its end, and the marks of an active and a done step. */
  rail: { start: string; line: string; end: string; active: string; done: string; todo: string };
  /** Eight levels, lowest first, for a sparkline. */
  spark: readonly string[];
  /** A filled and an empty cell of a bar. */
  bar: { full: string; empty: string };
}

const UNICODE: Glyphs = {
  brand: "◆",
  pointer: "❯",
  ok: "✓",
  warn: "!",
  error: "✗",
  pending: "○",
  off: "–",
  dot: "·",
  bullet: "•",
  rule: "─",
  arrow: "→",
  ellipsis: "…",
  check: "◼",
  uncheck: "◻",
  live: "●",
  box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  rail: { start: "┌", line: "│", end: "└", active: "◆", done: "◇", todo: "○" },
  spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
  bar: { full: "█", empty: "░" },
};

const ASCII: Glyphs = {
  brand: "*",
  pointer: ">",
  ok: "+",
  warn: "!",
  error: "x",
  pending: "o",
  off: "-",
  dot: "|",
  bullet: "-",
  rule: "-",
  arrow: "->",
  ellipsis: "...",
  check: "[x]",
  uncheck: "[ ]",
  live: "*",
  box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  rail: { start: "+", line: "|", end: "+", active: "*", done: "+", todo: "o" },
  spark: ["_", ".", ":", "-", "=", "+", "*", "#"],
  bar: { full: "#", empty: "." },
};

export interface Style {
  readonly glyph: Glyphs;
  readonly color: boolean;
  accent(text: string): string;
  strong(text: string): string;
  /** Secondary text: labels, hints, units. */
  dim(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
  /** Panel borders and rules. */
  line(text: string): string;
  /** A key cap: ` k `. */
  chip(text: string): string;
  /** A selected row's background, over text the caller has padded to the row's width. */
  highlight(text: string): string;
  /** The selected item of an action bar, and the others: both two columns wider than the text. */
  selected(text: string): string;
  unselected(text: string): string;
}

const sgr = (on: string, off: string) => (text: string) =>
  text === "" ? text : `\x1b[${on}m${text}\x1b[${off}m`;

const plain = (text: string) => text;

type SwatchRole = keyof ReturnType<typeof palette>;

export interface StyleOptions extends Pick<TerminalProfile, "color" | "unicode"> {
  depth?: ColorDepth;
  tone?: Tone;
}

export function terminalStyle(options: StyleOptions): Style {
  const glyph = options.unicode ? UNICODE : ASCII;
  if (!options.color) {
    return {
      glyph,
      color: false,
      accent: plain,
      strong: plain,
      dim: plain,
      ok: plain,
      warn: plain,
      error: plain,
      line: plain,
      chip: (text) => `[${text}]`,
      highlight: plain,
      selected: (text) => `[${text}]`,
      unselected: (text) => ` ${text} `,
    };
  }
  const depth = options.depth ?? "16";
  const colors = palette(options.tone ?? "dark");
  const fg = (role: SwatchRole) => {
    const swatch = colors[role];
    if (depth === "truecolor") return sgr(`38;2;${swatch.rgb.join(";")}`, "39");
    if (depth === "256") return sgr(`38;5;${swatch.x256}`, "39");
    return swatch.ansi === "2" ? sgr("2", "22") : sgr(swatch.ansi, "39");
  };
  const bg = (role: SwatchRole) => {
    const swatch = colors[role];
    if (depth === "truecolor") return sgr(`48;2;${swatch.rgb.join(";")}`, "49");
    if (depth === "256") return sgr(`48;5;${swatch.x256}`, "49");
    return sgr("7", "27");
  };
  const accent = fg("accent");
  const chipBg = bg("chip");
  const strong = sgr("1", "22");
  return {
    glyph,
    color: true,
    accent,
    strong,
    dim: fg("muted"),
    ok: accent,
    warn: fg("warn"),
    error: fg("error"),
    line: fg("line"),
    chip: (text) => chipBg(strong(` ${text} `)),
    highlight: bg("select"),
    selected: (text) =>
      depth === "16" ? sgr("7", "27")(` ${text} `) : chipBg(accent(` ${text} `)),
    unselected: (text) => ` ${text} `,
  };
}
