// SPDX-License-Identifier: Apache-2.0
// Panels for full-screen layouts: a rounded frame with its title set into the top border, content
// padded and cut to the inner width, and an exact outer size, so panels can sit side by side and a
// grid of them fills the screen to the row. Pure: lines in, lines out.
import type { Style } from "./style.js";
import { padEnd, truncate, visibleWidth } from "./text.js";

export type PanelTone = "normal" | "focus" | "warn";

export interface Panel {
  title: string;
  /** Quiet text after the title in the border: a scope, a key, a count. */
  note?: string;
  lines: readonly string[];
  tone?: PanelTone;
}

/** The narrowest panel drawn; anything narrower is drawn this wide. */
export const MIN_PANEL_WIDTH = 12;

/**
 * `panel` framed at exactly `width` columns and, when given, `height` rows (content cut, with an
 * ellipsis line, or padded). Without a height it is as tall as its content plus the frame.
 */
export function drawPanel(style: Style, panel: Panel, width: number, height?: number): string[] {
  const outer = Math.max(MIN_PANEL_WIDTH, width);
  const inner = outer - 4;
  const { box } = style.glyph;
  const tone = panel.tone ?? "normal";
  const border =
    tone === "focus"
      ? style.accent
      : tone === "warn"
        ? style.warn
        : (text: string) => style.line(text);
  const titleColor =
    tone === "focus" ? style.accent : tone === "warn" ? style.warn : (text: string) => text;
  let label = ` ${style.strong(titleColor(panel.title))}${panel.note ? `  ${style.dim(panel.note)}` : ""} `;
  if (visibleWidth(label) > outer - 4) label = truncate(label, outer - 4, style.glyph.ellipsis);
  const fill = Math.max(0, outer - 3 - visibleWidth(label));
  const top = `${border(`${box.tl}${box.h}`)}${label}${border(`${box.h.repeat(fill)}${box.tr}`)}`;
  const bottom = border(`${box.bl}${box.h.repeat(outer - 2)}${box.br}`);

  let content = [...panel.lines];
  if (height !== undefined) {
    const room = Math.max(0, height - 2);
    if (content.length > room) {
      content = content.slice(0, Math.max(0, room - 1));
      if (room > 0) content.push(style.dim(style.glyph.ellipsis));
    }
    while (content.length < room) content.push("");
  }
  const side = border(box.v);
  const body = content.map(
    (line) => `${side} ${padEnd(truncate(line, inner, style.glyph.ellipsis), inner)} ${side}`,
  );
  return [top, ...body, bottom];
}

/**
 * Blocks side by side: each block's lines padded to its width, `gap` spaces between blocks, every
 * row as tall as the tallest block.
 */
export function sideBySide(
  blocks: ReadonlyArray<readonly string[]>,
  widths: readonly number[],
  gap = 1,
): string[] {
  const height = Math.max(0, ...blocks.map((b) => b.length));
  const rows: string[] = [];
  for (let i = 0; i < height; i += 1) {
    rows.push(
      blocks
        .map((block, b) => padEnd(truncate(block[i] ?? "", widths[b]!), widths[b]!))
        .join(" ".repeat(gap))
        .trimEnd(),
    );
  }
  return rows;
}

/** `left` and `right` on one line of `width`, the right part flush right (dropped if no room). */
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return right && gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
}
