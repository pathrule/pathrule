// SPDX-License-Identifier: Apache-2.0
// Pathrule's colours in a terminal: the brand palette of @pathrule/ui (mint accent, amber warning,
// coral error, quiet greys) at whatever depth the terminal draws, for a dark or a light background.
//
// - Depth: 24-bit where the terminal says it draws it (COLORTERM, or a terminal known to), the
//   nearest of the 256 xterm colours where TERM says 256, and the terminal's own 16 colours
//   otherwise, so a basic terminal keeps its theme and contrast settings.
// - Tone: `PATHRULE_THEME=light|dark` wins; then the background the terminal reports when asked
//   (OSC 11, `queryBackground`); then COLORFGBG; dark when nothing says. Each tone has its own
//   accent: the dark one is unreadable on white and the light one muddy on black.
import type { Writable } from "node:stream";

export type ColorDepth = "16" | "256" | "truecolor";
export type Tone = "dark" | "light";

type Rgb = readonly [number, number, number];

interface Swatch {
  rgb: Rgb;
  /** The nearest xterm-256 colour. */
  x256: number;
  /** The 16-colour SGR code: the terminal's own colour, or an attribute (2 dim, 7 reverse). */
  ansi: string;
}

export interface Palette {
  accent: Swatch;
  warn: Swatch;
  error: Swatch;
  /** Secondary text: hints, labels, units. */
  muted: Swatch;
  /** Panel borders and rules. */
  line: Swatch;
  /** The background of a key cap. */
  chip: Swatch;
  /** The background of a selected row. */
  select: Swatch;
}

// @pathrule/ui tokens: --pr-accent, --pr-warn, --pr-danger, --pr-fg-3, --pr-accent-soft, --pr-bg-2.
// Lines are a step lighter (dark) or darker (light) than the UI's, because a terminal's own
// background is rarely the UI's near-black or white.
const DARK: Palette = {
  accent: { rgb: [62, 226, 157], x256: 79, ansi: "32" },
  warn: { rgb: [232, 182, 76], x256: 179, ansi: "33" },
  error: { rgb: [255, 122, 110], x256: 209, ansi: "31" },
  muted: { rgb: [141, 145, 139], x256: 245, ansi: "2" },
  line: { rgb: [66, 73, 66], x256: 239, ansi: "2" },
  chip: { rgb: [40, 46, 40], x256: 236, ansi: "7" },
  select: { rgb: [20, 42, 31], x256: 236, ansi: "7" },
};

const LIGHT: Palette = {
  accent: { rgb: [11, 127, 79], x256: 29, ansi: "32" },
  warn: { rgb: [143, 95, 0], x256: 94, ansi: "33" },
  error: { rgb: [184, 50, 31], x256: 124, ansi: "31" },
  muted: { rgb: [87, 92, 86], x256: 242, ansi: "2" },
  line: { rgb: [196, 202, 194], x256: 251, ansi: "2" },
  chip: { rgb: [228, 232, 227], x256: 254, ansi: "7" },
  select: { rgb: [226, 243, 234], x256: 255, ansi: "7" },
};

export function palette(tone: Tone): Palette {
  return tone === "light" ? LIGHT : DARK;
}

const TRUECOLOR_TERMINALS = ["iTerm.app", "WezTerm", "ghostty", "vscode", "Hyper", "Tabby"];

/** How many colours the terminal draws, from what its environment says. */
export function colorDepth(env: NodeJS.ProcessEnv): ColorDepth {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (TRUECOLOR_TERMINALS.includes(env.TERM_PROGRAM ?? "")) return "truecolor";
  const term = env.TERM ?? "";
  if (/-direct$/.test(term) || term === "xterm-kitty" || term === "alacritty") return "truecolor";
  if (/256/.test(term)) return "256";
  return "16";
}

/** The tone the environment states: PATHRULE_THEME, then COLORFGBG ("fg;bg"). Null: unknown. */
export function statedTone(env: NodeJS.ProcessEnv): Tone | null {
  const forced = (env.PATHRULE_THEME ?? "").toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  const bg = (env.COLORFGBG ?? "").split(";").pop();
  if (bg && /^\d+$/.test(bg)) {
    const index = Number(bg);
    return index === 7 || index >= 9 ? "light" : "dark";
  }
  return null;
}

/** The tone of a background colour reported as `rgb:RRRR/GGGG/BBBB` (1-4 hex digits each). */
export function toneOfReport(report: string): Tone | null {
  const match = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(report);
  if (!match) return null;
  const channel = (hex: string) => parseInt(hex, 16) / (16 ** hex.length - 1);
  const [r, g, b] = [channel(match[1]!), channel(match[2]!), channel(match[3]!)];
  // Relative luminance (sRGB weights) is enough to tell a dark background from a light one.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

interface QueryInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Asks the terminal for its background colour (OSC 11) and reads the answer for `timeoutMs`. Null
 * when it does not answer in time: many terminals answer, some never do. An answer arriving later
 * reaches the key reader, which drops terminal reports (keys.ts).
 */
export async function queryBackground(
  input: QueryInput,
  output: Pick<Writable, "write">,
  timeoutMs = 120,
): Promise<Tone | null> {
  if (!input.isTTY || !input.setRawMode) return null;
  return new Promise<Tone | null>((resolve) => {
    let buffer = "";
    const finish = (tone: Tone | null) => {
      clearTimeout(timer);
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      resolve(tone);
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (/\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/.test(buffer)) finish(toneOfReport(buffer));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.setRawMode!(true);
    input.on("data", onData);
    input.resume();
    output.write("\x1b]11;?\x1b\\");
  });
}
