// SPDX-License-Identifier: Apache-2.0
// What the terminal in front of this run can show: whether a person is there at all, its width,
// colour, Unicode, and whether the cursor can move. Every screen of the terminal experience reads
// this once and degrades from it: no colour is plain text, no Unicode is ASCII glyphs, a dumb
// terminal gets no cursor movement (each screen is printed again below the last instead of being
// redrawn in place). Nothing here animates, so reduced-motion settings have nothing to turn off.
//
// `PATHRULE_PLAIN=1` asks for plain text: for a screen reader, a braille display or a log. Screens
// are printed once, top to bottom, in ASCII without colour or decorative rules, and questions are
// asked as numbered lines answered with Enter instead of keys that redraw the screen.
import type { CliOutputMode } from "../output.js";
import type { CliRuntime } from "../plugin.js";
import { colorDepth, statedTone, type ColorDepth, type Tone } from "./theme.js";

export interface TerminalProfile {
  /** A person at a keyboard: stdin and stdout are terminals, and the run is not --json or CI. */
  interactive: boolean;
  color: boolean;
  unicode: boolean;
  /** Whether lines can be cleared and the cursor moved up to redraw a screen in place. */
  cursor: boolean;
  /** The usable width: the terminal's columns, clamped, with one column kept free to avoid wraps. */
  columns: number;
  /** The terminal's height: a screen taller than this cannot be redrawn in place. */
  rows: number;
  /** Plain text: printed once, line-answered questions, no redraws (`PATHRULE_PLAIN=1`). */
  plain: boolean;
  /** How many colours the terminal draws (theme.ts). */
  depth?: ColorDepth;
  /** Whether the background is dark or light: stated by the environment, or asked (theme.ts). */
  tone?: Tone;
}

/** The narrowest width the screens lay out for; anything narrower is treated as this. */
export const MIN_COLUMNS = 32;
/** Wider terminals still get lines this long: long lines read badly. */
export const MAX_COLUMNS = 120;
const DEFAULT_COLUMNS = 80;

interface StreamLike {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

/** Whether a stream is a terminal, read the way Node sets it on process streams. */
export function isTerminal(stream: unknown): boolean {
  return (stream as StreamLike | null)?.isTTY === true;
}

/** The width to lay out for, from a stream's `columns` (unknown: 80). */
export function layoutColumns(stream: unknown): number {
  const raw = (stream as StreamLike | null)?.columns;
  const columns = typeof raw === "number" && raw > 0 ? raw : DEFAULT_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, columns - 1));
}

/** The terminal's height in rows (unknown: 24). */
export function layoutRows(stream: unknown): number {
  const raw = (stream as StreamLike | null)?.rows;
  return typeof raw === "number" && raw > 0 ? raw : 24;
}

/**
 * Whether the terminal renders the box-drawing and symbol glyphs the screens use. The locale says
 * so on Unix; the Linux console and the legacy Windows console do not, whatever the locale.
 * `PATHRULE_ASCII=1` forces ASCII.
 */
export function supportsUnicode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.PATHRULE_ASCII === "1" || env.PATHRULE_ASCII === "true") return false;
  if (env.TERM === "linux" || env.TERM === "dumb") return false;
  if (platform === "win32") {
    return Boolean(env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.ConEmuANSI === "ON");
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (/utf-?8/i.test(locale)) return true;
  return ["iTerm.app", "Apple_Terminal", "vscode", "WezTerm", "ghostty", "Hyper"].includes(
    env.TERM_PROGRAM ?? "",
  );
}

/** Whether `PATHRULE_PLAIN` asks for plain, linear text. */
export function wantsPlainText(env: NodeJS.ProcessEnv): boolean {
  return env.PATHRULE_PLAIN === "1" || env.PATHRULE_PLAIN === "true";
}

/** Whether a person is at this run's terminal: what decides between the home and plain help. */
export function personAtTerminal(runtime: CliRuntime, mode: CliOutputMode): boolean {
  if (mode.json || !mode.interactive) return false;
  if (runtime.env.TERM === "dumb") return false;
  const stdin = runtime.stdinIsTTY ?? process.stdin.isTTY === true;
  return stdin && isTerminal(runtime.stdout);
}

export function terminalProfile(runtime: CliRuntime, mode: CliOutputMode): TerminalProfile {
  const interactive = personAtTerminal(runtime, mode);
  const dumb = runtime.env.TERM === "dumb";
  const plain = wantsPlainText(runtime.env);
  return {
    interactive,
    color: mode.color && !dumb && !plain && isTerminal(runtime.stdout),
    unicode: !plain && supportsUnicode(runtime.env),
    cursor: interactive && !dumb && !plain,
    plain,
    columns: layoutColumns(runtime.stdout),
    rows: layoutRows(runtime.stdout),
    depth: colorDepth(runtime.env),
    tone: statedTone(runtime.env) ?? "dark",
  };
}
