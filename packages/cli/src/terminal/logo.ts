// SPDX-License-Identifier: Apache-2.0
// The Pathrule lockup for the terminal, in Braille cells (2 x 4 dots each): the mark in the accent,
// the wordmark in the terminal's own text colour, bold (white on a dark terminal, dark on a light
// one), as the owner asked. Three sizes, the largest that fits:
//
// - **Large** (101 x 16 cells): drawn by the owner (2026-10-10). Only the image converter's filler
//   (U+2804, one dot in every empty cell, which a terminal shows as dotted lines) was turned back
//   into blanks and the empty margins trimmed; nothing else was changed.
// - **Medium** (76 x 9): drawn from the official SVG, never freehand: the mark rasterized at 26 x 36
//   dots on a dark ground (threshold 110 of 255, its outer stem evened by hand); the wordmark's
//   letters cut apart as shapes at high resolution, each reduced to 24 dots tall by area (half
//   covered or more is a dot), and set two dots apart, because at the logo's own tight spacing,
//   fonts that draw Braille as an even grid of square dots ran the letters together.
// - **Small**: the medium mark with the name in text beside it.
//
// ASCII terminals and plain text get the name alone. Redraw from the source if the logo changes.
import type { Style } from "./style.js";

/** The large lockup, as the owner drew it: 101 cells wide, 16 rows. */
const LARGE = [
  "      ⢀⣴⣿⣿⣷⣤⡀",
  "    ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣦⣄",
  " ⢀⣤⣾⣿⣿⣿⣿⡿⠛⢿⣿⣿⣿⣿⣷⣤⡀                                     ⣤⣤⣤                            ⣤⣤⣤",
  "⣴⣿⣿⣿⣿⣿⠟⠉   ⠉⠻⣿⣿⣿⣿⣿⣦      ⢠⣤⣤⣤⣤⣤⣤⣤⡀              ⢀⣀⡄    ⣿⣿⣿                            ⣿⣿⣿",
  "⣿⣿⣿⡿⠛⠁   ⢀⣤⣄ ⠈⠛⢿⣿⣿⣿      ⢸⣿⣿⠿⠿⠿⣿⣿⣿⣦             ⣿⣿⡗    ⣿⣿⣿                            ⣿⣿⣿",
  "⣿⣿⣿⡇   ⣠⣴⣿⣿⣿⣷⣆ ⢸⣿⣿⣿      ⢸⣿⣿    ⢹⣿⣿⡆  ⣠⣤⣤⣤⣤⡀  ⣤⣤⣿⣿⣧⣤⣤⣤ ⣿⣿⣿⢀⣤⣤⣤⣄⡀   ⣤⣤⡄⣠⣤⣤⡄⢠⣤⣤    ⢠⣤⣤  ⣿⣿⣿    ⢀⣤⣤⣤⣤⣀",
  "⣿⣿⣿⡇ ⢀⣾⣿⣿⣿⣿⡿⠟⠁ ⢸⣿⣿⣿      ⢸⣿⣿    ⢸⣿⣿⡇⢠⣾⣿⣿⠿⢿⣿⣿⣦ ⠿⠿⣿⣿⡿⠿⠿⠿ ⣿⣿⣿⣿⡿⢿⣿⣿⣿⡄  ⣿⣿⣿⣿⣿⣿⡇⢸⣿⣿    ⢸⣿⣿  ⣿⣿⣿   ⣴⣿⣿⡿⠿⣿⣿⣷⡀",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡿⠋    ⢸⣿⣿⣿      ⢸⣿⣿⣀⣀⣀⣠⣾⣿⣿⠁⠘⠿⡟⠁  ⢹⣿⣿   ⣿⣿⡇    ⣿⣿⣿⠋  ⠘⣿⣿⡇  ⣿⣿⣿⠋   ⢸⣿⣿    ⢸⣿⣿  ⣿⣿⣿  ⣸⣿⣿⠃  ⠈⣿⣿⣧",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡇   ⢀⣴⣾⣿⣿⣿      ⢸⣿⣿⣿⣿⣿⣿⣿⠟⠁   ⣀⣠⣤⣴⣾⣿⣿⡇  ⣿⣿⡇    ⣿⣿⣿    ⣿⣿⣿  ⣿⣿⡇    ⢸⣿⣿    ⢸⣿⣿  ⣿⣿⣿  ⣿⣿⣿⣶⣶⣶⣶⣾⣿⣿",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡇ ⣠⣶⣿⣿⣿⣿⣿⠟      ⢸⣿⣿⠉⠉⠉⠁    ⢠⣾⣿⡿⠿⠛⢻⣿⣿⡇  ⣿⣿⡇    ⣿⣿⣿    ⣿⣿⣿  ⣿⣿⡇    ⢸⣿⣿    ⣸⣿⣿  ⣿⣿⣿  ⣿⣿⣟⠛⠛⠛⠛⠛⠛⠛",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡇ ⣿⣿⣿⣿⡿⠋⠁       ⢸⣿⣿        ⣾⣿⣿   ⣸⣿⣿⡇  ⣿⣿⣷  ⢀ ⣿⣿⣿    ⣿⣿⣿  ⣿⣿⡇    ⢸⣿⣿⡄  ⣠⣿⣿⣿  ⣿⣿⣿  ⢹⣿⣿⡄   ⣰⣦⣀",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡃ ⣿⣿⠟⠋          ⢸⣿⣿        ⢹⣿⣿⣷⣶⣾⣿⣿⣿⣷⡆ ⢻⣿⣿⣷⣶⣿ ⣿⣿⣿    ⣿⣿⣿  ⣿⣿⡇    ⠘⢿⣿⣿⣶⣾⣿⢿⣿⣿  ⢻⣿⣿⣶⣶ ⠻⣿⣿⣷⣶⣾⣿⡿⠃",
  "⣿⣿⣿⡇ ⢸⣿⣿⣿⡇ ⠉⠁            ⠘⠛⠛         ⠉⠛⠛⠛⠋⠁⠙⠛⠛⠃  ⠙⠛⠛⠛⠋ ⠛⠛⠛    ⠛⠛⠛  ⠛⠛⠃     ⠈⠙⠛⠛⠛⠉⠘⠛⠛   ⠛⠛⠛⠋  ⠈⠛⠛⠛⠛⠋",
  "⠈⠙⠿⠇ ⢸⣿⣿⣿⠁",
  "     ⢸⣿⣿⣿",
  "      ⠙⢿⣿",
] as const;

const LARGE_WIDTH = 101;
/** Where the large lockup's mark ends: its first 19 cells; the wordmark starts after a gap of 6. */
const LARGE_MARK_WIDTH = 19;
/** The large lockup is shown only where the rest of the welcome still fits under it. */
const LARGE_MIN_ROWS = 30;

/** The mark: 13 cells wide. */
const MARK = [
  "   ⢀⣠⣶⣷⣦⣄    ",
  "⢀⣠⣶⣿⣿⠟⠛⢿⣿⣷⣦⣀ ",
  "⣿⣿⡟⠋  ⢀⣀⠈⠛⢿⣿⡇",
  "⣿⣿  ⣤⣾⣿⡿⠟ ⢸⣿⡇",
  "⣿⣿  ⣿⣿⠋  ⢀⣼⣿⡇",
  "⣿⣿  ⣿⣿ ⢠⣶⣿⣿⠟⠃",
  "⣿⣿  ⣿⣿ ⠸⠟⠋   ",
  "⠙⠻  ⣿⣿       ",
  "    ⠻⢿       ",
] as const;

/** The wordmark "Pathrule", on the mark's rows: 60 cells wide, its letters evenly spaced. */
const WORDMARK = [
  "",
  "⣤⣤⣤⣤⣤⣄⡀            ⢀⣀⡀   ⣿⣿                    ⢸⣿⡇",
  "⣿⣿⠉⠉⠉⠻⣿⡆   ⣀⣀⣀    ⣀⣸⣿⣇⣀⣀ ⣿⣿ ⣀⣀⡀  ⢀⣀ ⢀⣀⡀⢀⣀    ⣀⡀⢸⣿⡇    ⢀⣀⣀⡀",
  "⣿⣿   ⢀⣿⡏ ⣴⣿⠛⠛⠻⣿⣆  ⠛⢻⣿⡟⠛⠛ ⣿⣿⠾⠛⠛⢿⣷ ⢸⣿⣾⠟⠛⠃⢸⣿⡇   ⣿⡇⢸⣿⡇  ⢠⣾⠟⠛⠛⢿⣷⡀",
  "⣿⣿⣶⣶⣾⠿⠟⠁  ⢀⣀⣠⣤⣿⣿   ⢸⣿⡇   ⣿⣿   ⢸⣿⡇⢸⣿⡇   ⢸⣿⡇   ⣿⡇⢸⣿⡇  ⣿⣿⣤⣤⣤⣬⣿⡇",
  "⣿⣿       ⣾⣿⠋⠉ ⣿⣿   ⢸⣿⡇   ⣿⣿   ⢸⣿⡇⢸⣿⡇   ⢸⣿⡇  ⢀⣿⡇⢸⣿⡇  ⢿⣿    ⣀",
  "⣿⡿       ⠻⢿⣶⣶⠞⠻⣿⡶  ⠘⢿⣷⣶⡶ ⣿⡿   ⢸⣿⠇⢸⣿⠇   ⠈⠻⣿⣶⡶⠟⢿⡇⠘⢿⣷⡶ ⠈⠻⢷⣶⣶⡾⠟⠁",
  "",
  "",
] as const;

const MARK_WIDTH = 13;
const GAP = "   ";
const WORDMARK_WIDTH = 60;
/** The full lockup's width in cells. */
export const LOGO_WIDTH = MARK_WIDTH + GAP.length + WORDMARK_WIDTH;

/**
 * The lockup for a terminal `columns` wide and `rows` tall, each line starting with `indent`: the
 * largest size that fits, the name alone without Unicode or in plain text.
 */
export function renderLogo(
  style: Style,
  columns: number,
  options: { indent?: string; plain?: boolean; unicode?: boolean; rows?: number } = {},
): string[] {
  const indent = options.indent ?? "";
  const room = columns - indent.length;
  /** One row: the mark's cells in the accent, the wordmark's in bold text colour. */
  const row = (cells: string, markWidth: number) => {
    const all = [...cells];
    const mark = all.slice(0, markWidth).join("");
    const word = all.slice(markWidth).join("").trimEnd();
    return word
      ? `${indent}${style.accent(mark)}${style.strong(word)}`
      : `${indent}${style.accent(mark.trimEnd())}`.trimEnd();
  };
  if (options.plain || options.unicode === false || room < MARK_WIDTH + GAP.length + 8) {
    return [`${indent}${style.accent(style.glyph.brand)} ${style.strong("Pathrule")}`];
  }
  if (room >= LARGE_WIDTH && (options.rows ?? 0) >= LARGE_MIN_ROWS) {
    return LARGE.map((cells) => row(cells, LARGE_MARK_WIDTH));
  }
  if (room >= LOGO_WIDTH)
    return MARK.map((mark, i) => row(`${mark}${GAP}${WORDMARK[i]!}`, MARK_WIDTH));
  const middle = Math.floor(MARK.length / 2);
  return MARK.map((mark, i) => row(i === middle ? `${mark}${GAP}Pathrule` : mark, MARK_WIDTH));
}
