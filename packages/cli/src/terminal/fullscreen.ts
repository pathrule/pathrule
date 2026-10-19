// SPDX-License-Identifier: Apache-2.0
// A screen that owns the whole terminal while it is open: the alternate screen, as full-screen
// terminal tools use it, so the home can lay out panels to the terminal's size and leaving puts back
// exactly what was there before. Each draw repaints from the top-left; lines are cut to the width so
// none wraps. Leaving (and the process exiting by any path) restores the normal screen and cursor.
//
// The home leaves it before a flow that prints and asks on its own (sign-in, the integrations
// wizard): that output belongs in the normal scrollback, where the person can read it afterwards.
import type { Writable } from "node:stream";

import { truncate } from "./text.js";

const ENTER = "\x1b[?1049h\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?1049l";

export class FullScreen {
  private active = false;
  private readonly restore = () => {
    if (this.active) this.out.write(LEAVE);
  };

  constructor(
    private readonly out: Pick<Writable, "write">,
    private readonly ellipsis = "…",
  ) {}

  get isOpen(): boolean {
    return this.active;
  }

  open(): void {
    if (this.active) return;
    this.active = true;
    process.once("exit", this.restore);
    this.out.write(ENTER);
  }

  /**
   * Paints `lines` from the top, each cut to `columns`, and clears whatever is below them. No line
   * break follows the last line: on the bottom row one would scroll the whole screen up.
   */
  draw(lines: readonly string[], columns: number): void {
    if (!this.active) this.open();
    const body = lines
      .map((line) => `\x1b[2K${truncate(line, columns, this.ellipsis)}`)
      .join("\r\n");
    this.out.write(`\x1b[H${body}\x1b[J`);
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    process.off("exit", this.restore);
    this.out.write(LEAVE);
  }
}
