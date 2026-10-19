// SPDX-License-Identifier: Apache-2.0
// A screen drawn inline, below whatever the terminal already shows: never the alternate screen, so
// nothing a person ran before disappears and leaving is just the next prompt. With cursor control it
// redraws in place (up by the lines it drew, then clear to the end); without, each draw is printed
// below the last. Lines are cut to the terminal's width, so a line never wraps and the count of
// lines drawn is the count of rows to move up.
import type { Writable } from "node:stream";

import type { TerminalProfile } from "./profile.js";
import { truncate } from "./text.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export class InlineScreen {
  private height = 0;
  private cursorHidden = false;
  private readonly restore = () => this.showCursor();

  constructor(
    private readonly out: Pick<Writable, "write">,
    private profile: TerminalProfile,
    private readonly ellipsis = "…",
  ) {}

  /** Lay out for a resized terminal from the next draw on. */
  resize(profile: TerminalProfile): void {
    this.profile = profile;
  }

  get columns(): number {
    return this.profile.columns;
  }

  draw(lines: readonly string[]): void {
    // Taller than the terminal: the top would scroll away and could not be reached to redraw, so
    // it is printed below instead, and the next draw starts under it.
    if (this.profile.cursor && lines.length >= this.profile.rows) {
      this.clear();
      this.out.write(
        lines.map((line) => `${truncate(line, this.profile.columns, this.ellipsis)}\n`).join(""),
      );
      return;
    }
    let text = "";
    if (this.profile.cursor) {
      if (!this.cursorHidden) {
        this.cursorHidden = true;
        text += HIDE_CURSOR;
        process.once("exit", this.restore);
      }
      if (this.height > 0) text += `\x1b[${this.height}A\r`;
    }
    for (const line of lines) {
      text += `${this.profile.cursor ? "\x1b[2K" : ""}${truncate(line, this.profile.columns, this.ellipsis)}\n`;
    }
    if (this.profile.cursor) text += "\x1b[J";
    this.out.write(text);
    this.height = lines.length;
  }

  /** Leaves what was drawn on the terminal; the next draw starts below it. */
  release(): void {
    this.height = 0;
    this.showCursor();
  }

  /** Clears what was drawn, for a flow that prints its own output in its place. */
  clear(): void {
    if (this.profile.cursor && this.height > 0) {
      this.out.write(`\x1b[${this.height}A\r\x1b[J`);
    }
    this.height = 0;
    this.showCursor();
  }

  private showCursor(): void {
    if (!this.cursorHidden) return;
    this.cursorHidden = false;
    process.off("exit", this.restore);
    this.out.write(SHOW_CURSOR);
  }
}
