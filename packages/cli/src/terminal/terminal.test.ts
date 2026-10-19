// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { CliRuntime } from "../plugin.js";
import { drawPanel, sideBySide } from "./box.js";
import { FullScreen } from "./fullscreen.js";
import { parseKeys, scriptedKeys } from "./keys.js";
import { layoutColumns, personAtTerminal, supportsUnicode, terminalProfile } from "./profile.js";
import { InlineScreen } from "./screen.js";
import { terminalStyle } from "./style.js";
import {
  formatAgo,
  formatBytes,
  formatCount,
  padEnd,
  stripAnsi,
  terminalSafe,
  tildePath,
  truncate,
  visibleWidth,
  wrap,
} from "./text.js";
import { LOGO_WIDTH, renderLogo } from "./logo.js";
import { colorDepth, statedTone, toneOfReport } from "./theme.js";
import { TerminalUi } from "./ui.js";

class Writer {
  chunks: string[] = [];
  constructor(
    readonly isTTY = false,
    readonly columns?: number,
    readonly rows?: number,
  ) {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  toString() {
    return this.chunks.join("");
  }
}

function runtime(stdout: Writer, extra: Partial<CliRuntime> = {}): CliRuntime {
  return {
    cwd: "/",
    env: { LANG: "en_US.UTF-8" },
    stdout,
    stderr: new Writer(),
    stdinIsTTY: true,
    ...extra,
  };
}

const MODE = { json: false, color: true, interactive: true };

describe("terminal text", () => {
  it("counts cells, not code units or escapes", () => {
    expect(visibleWidth("\x1b[36mabc\x1b[39m")).toBe(3);
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("é")).toBe(1);
    expect(stripAnsi("\x1b[1mbold\x1b[22m")).toBe("bold");
  });

  it("truncates to a width, closing an open style", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    const styled = truncate("\x1b[36mabcdef\x1b[39m", 4, "...");
    expect(visibleWidth(styled)).toBe(4);
    expect(styled.endsWith("\x1b[0m...")).toBe(true);
    expect(visibleWidth(truncate("日本語テキスト", 5))).toBeLessThanOrEqual(5);
  });

  it("wraps at spaces and pads by cells", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrap("supercalifragilistic", 6)).toEqual(["super…"]);
    expect(padEnd("\x1b[1mab\x1b[22m", 4)).toBe("\x1b[1mab\x1b[22m  ");
  });

  it("formats numbers, sizes, ages and paths the same everywhere", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatBytes(2_638_376_759)).toBe("2.6 GB");
    expect(formatBytes(512)).toBe("512 B");
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(formatAgo("2026-10-10T11:59:30Z", now)).toBe("just now");
    expect(formatAgo("2026-10-10T11:56:00Z", now)).toBe("4 min ago");
    expect(formatAgo("2026-10-10T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-10-07T12:00:00Z", now)).toBe("3 d ago");
    expect(formatAgo("not a date", now)).toBe("unknown");
    expect(tildePath("/Users/a/code", "/Users/a")).toBe("~/code");
    expect(tildePath("/Users/ab/code", "/Users/a")).toBe("/Users/ab/code");
  });
});

describe("keys", () => {
  it("parses arrows, Enter, Esc, Ctrl-C and characters, several per chunk", () => {
    expect(parseKeys("\x1b[A\x1b[Bq\r").map((k) => k.name)).toEqual([
      "up",
      "down",
      "char",
      "enter",
    ]);
    expect(parseKeys("\x1b")).toEqual([{ name: "escape" }]);
    expect(parseKeys("\x03")).toEqual([{ name: "interrupt" }]);
    expect(parseKeys("\x1bOC\x1b[D")).toEqual([{ name: "right" }, { name: "left" }]);
    expect(parseKeys("\x1b[3~x")).toEqual([{ name: "char", char: "x" }]);
    expect(parseKeys("é")).toEqual([{ name: "char", char: "é" }]);
  });

  it("scripted keys run out into Ctrl-C, so a test never waits forever", async () => {
    const keys = scriptedKeys(["a"]);
    expect(await keys.next()).toEqual({ name: "char", char: "a" });
    expect(await keys.next()).toEqual({ name: "interrupt" });
  });
});

describe("terminal profile", () => {
  it("opens for a person only: both ends a terminal, no --json, no CI, no dumb terminal", () => {
    const tty = new Writer(true, 100);
    expect(personAtTerminal(runtime(tty), MODE)).toBe(true);
    expect(personAtTerminal(runtime(new Writer(false)), MODE)).toBe(false);
    expect(personAtTerminal(runtime(tty, { stdinIsTTY: false }), MODE)).toBe(false);
    expect(personAtTerminal(runtime(tty), { ...MODE, json: true })).toBe(false);
    expect(personAtTerminal(runtime(tty), { ...MODE, interactive: false })).toBe(false);
    expect(personAtTerminal(runtime(tty, { env: { TERM: "dumb" } }), MODE)).toBe(false);
  });

  it("falls back to ASCII where the terminal cannot draw the glyphs", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" }, "darwin")).toBe(true);
    expect(supportsUnicode({ LANG: "C" }, "linux")).toBe(false);
    expect(supportsUnicode({ LANG: "en_US.UTF-8", TERM: "linux" }, "linux")).toBe(false);
    expect(supportsUnicode({ LANG: "en_US.UTF-8", PATHRULE_ASCII: "1" }, "darwin")).toBe(false);
    expect(supportsUnicode({}, "win32")).toBe(false);
    expect(supportsUnicode({ WT_SESSION: "x" }, "win32")).toBe(true);
  });

  it("lays out within bounds and keeps one column free", () => {
    expect(layoutColumns({ columns: 80 })).toBe(79);
    expect(layoutColumns({ columns: 10 })).toBe(32);
    expect(layoutColumns({ columns: 400 })).toBe(120);
    expect(layoutColumns({})).toBe(79);
  });

  it("colours only a terminal, and NO_COLOR (mode.color false) wins", () => {
    expect(terminalProfile(runtime(new Writer(true)), MODE).color).toBe(true);
    expect(terminalProfile(runtime(new Writer(true)), { ...MODE, color: false }).color).toBe(false);
    expect(terminalProfile(runtime(new Writer(false)), MODE).color).toBe(false);
  });
});

describe("style", () => {
  it("is plain text without colour, with selected and other items equally wide", () => {
    const plain = terminalStyle({ color: false, unicode: false });
    expect(plain.accent("x")).toBe("x");
    expect(visibleWidth(plain.selected("a Agents"))).toBe(
      visibleWidth(plain.unselected("a Agents")),
    );
    const color = terminalStyle({ color: true, unicode: true });
    expect(visibleWidth(color.selected("a Agents"))).toBe(
      visibleWidth(color.unselected("a Agents")),
    );
    expect(plain.glyph.ok).toBe("+");
    expect(color.glyph.ok).toBe("✓");
  });
});

describe("inline screen", () => {
  const profile = {
    interactive: true,
    color: false,
    unicode: true,
    cursor: true,
    plain: false,
    columns: 20,
    rows: 10,
  };

  it("redraws in place by the lines it drew, and never writes a line wider than the terminal", () => {
    const out = new Writer(true);
    const screen = new InlineScreen(out, profile);
    screen.draw(["one", "x".repeat(50)]);
    screen.draw(["two"]);
    const text = out.toString();
    expect(text).toContain("\x1b[2A\r");
    for (const line of stripAnsi(text).split("\n"))
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    screen.release();
    expect(out.toString().endsWith("\x1b[?25h")).toBe(true);
  });

  it("prints a screen taller than the terminal below instead of moving the cursor past the top", () => {
    const out = new Writer(true);
    const screen = new InlineScreen(out, profile);
    screen.draw(Array.from({ length: 12 }, (_, i) => `line ${i}`));
    screen.draw(["after"]);
    expect(out.toString()).not.toContain("\x1b[12A");
  });

  it("without cursor control, appends every draw", () => {
    const out = new Writer(false);
    const screen = new InlineScreen(out, { ...profile, cursor: false });
    screen.draw(["a"]);
    screen.draw(["b"]);
    expect(out.toString()).toBe("a\nb\n");
  });
});

describe("palette and tone", () => {
  it("draws 24-bit colour where the terminal says so, 256 where TERM does, its own 16 otherwise", () => {
    expect(colorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorDepth({ TERM_PROGRAM: "iTerm.app" })).toBe("truecolor");
    expect(colorDepth({ TERM: "xterm-256color" })).toBe("256");
    expect(colorDepth({ TERM: "xterm" })).toBe("16");
    const accent = (depth: "16" | "256" | "truecolor", tone: "dark" | "light") =>
      terminalStyle({ color: true, unicode: true, depth, tone }).accent("x");
    expect(accent("truecolor", "dark")).toBe("\x1b[38;2;62;226;157mx\x1b[39m");
    expect(accent("truecolor", "light")).toBe("\x1b[38;2;11;127;79mx\x1b[39m");
    expect(accent("256", "dark")).toBe("\x1b[38;5;79mx\x1b[39m");
    expect(accent("16", "dark")).toBe("\x1b[32mx\x1b[39m");
  });

  it("takes the tone from PATHRULE_THEME, then COLORFGBG, then the terminal's answer", () => {
    expect(statedTone({ PATHRULE_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(statedTone({ COLORFGBG: "15;0" })).toBe("dark");
    expect(statedTone({ COLORFGBG: "0;15" })).toBe("light");
    expect(statedTone({})).toBeNull();
    expect(toneOfReport("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("light");
    expect(toneOfReport("\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\")).toBe("dark");
    expect(toneOfReport("garbage")).toBeNull();
  });

  it("never turns a terminal's late answer into key presses", () => {
    expect(parseKeys("\x1b]11;rgb:ffff/ffff/ffff\x1b\\q")).toEqual([{ name: "char", char: "q" }]);
    expect(parseKeys("a\x1b]11;rgb:0/0/0\x07b").map((k) => k.char)).toEqual(["a", "b"]);
  });
});

describe("stored text in the terminal", () => {
  it("keeps line breaks and tabs and drops every escape and control", () => {
    expect(terminalSafe("a\tb\nc")).toBe("a\tb\nc");
    expect(terminalSafe("x\x1b[31my\x1b[0m")).toBe("xy");
    expect(terminalSafe("t\x1b]0;title\x07u")).toBe("tu");
    expect(terminalSafe("p\x1bPdata\x1b\\q")).toBe("pq");
    expect(terminalSafe("\x9b2Jz\x07\x00")).toBe("z");
  });
});

describe("full screen", () => {
  it("opens the alternate screen, paints from the top without scrolling, and always gives it back", () => {
    const out = new Writer(true);
    const screen = new FullScreen(out);
    screen.draw(["one", "x".repeat(40)], 10);
    expect(out.chunks[0]).toBe("\x1b[?1049h\x1b[?25l");
    const frame = out.chunks[1]!;
    expect(frame.startsWith("\x1b[H")).toBe(true);
    expect(frame.endsWith("\x1b[J")).toBe(true);
    expect(frame).not.toMatch(/\r\n\x1b\[J$/); // no line break after the last line
    for (const line of stripAnsi(frame).split("\r\n"))
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    screen.close();
    screen.close();
    expect(out.chunks.filter((c) => c === "\x1b[?25h\x1b[?1049l")).toHaveLength(1);
  });
});

describe("panels", () => {
  const style = terminalStyle({ color: true, unicode: true, depth: "256", tone: "dark" });

  it("are exactly as wide and tall as asked, content cut or padded", () => {
    const lines = drawPanel(
      style,
      { title: "Knowledge", note: "k", lines: ["a", "b".repeat(80), "c", "d"] },
      30,
      5,
    );
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(visibleWidth(line)).toBe(30);
    expect(stripAnsi(lines[0]!)).toMatch(/^╭─ Knowledge {2}k ─+╮$/);
    expect(stripAnsi(lines[3]!)).toContain("…");
  });

  it("sit side by side, as tall as the tallest", () => {
    const left = drawPanel(style, { title: "A", lines: ["1", "2", "3"] }, 14);
    const right = drawPanel(style, { title: "B", lines: ["1"] }, 14);
    const rows = sideBySide([left, right], [14, 14]);
    expect(rows).toHaveLength(5);
    expect(visibleWidth(rows[0]!)).toBe(29);
  });
});

describe("the setup rail", () => {
  it("asks on one line down the terminal and folds a question to its answer", async () => {
    const out = new Writer(true, 80, 30);
    const runtime = {
      cwd: "/",
      env: { LANG: "en_US.UTF-8" },
      stdout: out,
      stderr: new Writer(),
    } as unknown as CliRuntime;
    const ui = new TerminalUi({
      runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: true,
        plain: false,
        columns: 79,
        rows: 30,
      },
      keys: scriptedKeys(["\x1b[B", "\r"]),
    });
    ui.railStart("Pathrule", "v1");
    ui.write(["A note."]);
    const choice = await ui.choose({
      title: "Choose one",
      step: "step 1 of 2",
      options: [
        { value: "a", label: "First" },
        { value: "b", label: "Second" },
      ],
    });
    ui.write([...ui.heading("Next", "step 2 of 2")]);
    ui.railEnd("Done.");
    expect(choice).toBe("b");
    const text = stripAnsi(out.chunks.join(""));
    expect(text).toMatch(/^┌ {2}◆ Pathrule +v1$/m);
    expect(text).toContain("│  A note.");
    expect(text).toMatch(/◆ {2}Choose one +step 1 of 2/);
    expect(text).toMatch(/◇ {2}Choose one\n(\x1b\[2K)?│ {2}Second/);
    // A heading written on the rail is the rail's own step, not a line on it.
    expect(text).toMatch(/^◆ {2}Next +step 2 of 2$/m);
    expect(text).not.toContain("│  ◆");
    expect(text).toMatch(/^└ {2}Done\.$/m);
  });

  it("is plain lines in plain mode: no rail, numbered questions", async () => {
    const out = new Writer(false);
    const runtime = {
      cwd: "/",
      env: {},
      stdout: out,
      stderr: new Writer(),
      promptLine: async () => "2",
    } as unknown as CliRuntime;
    const ui = new TerminalUi({
      runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: false,
        cursor: false,
        plain: true,
        columns: 79,
        rows: 30,
      },
    });
    ui.railStart("Pathrule");
    const choice = await ui.choose({
      title: "Choose one",
      step: "step 1 of 2",
      options: [
        { value: "a", label: "First" },
        { value: "b", label: "Second" },
      ],
    });
    ui.railEnd("Done.");
    expect(choice).toBe("b");
    const text = out.chunks.join("");
    expect(text).not.toMatch(/[│┌└◆◇]/);
    expect(text).toContain("Choose one (step 1 of 2)");
    expect(text).toContain("2. Second");
  });
});

describe("the logo", () => {
  const style = terminalStyle({ color: true, unicode: true, depth: "truecolor", tone: "dark" });
  const ACCENT = "\x1b[38;2;62;226;157m";

  it("is the owner's large lockup on a wide, tall terminal: mark in the accent, wordmark in bold text colour, no filler dots", () => {
    const lines = renderLogo(style, 120, { indent: "   ", rows: 40 });
    expect(lines).toHaveLength(16);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(3 + 101);
      expect(line).toContain(ACCENT);
    }
    // The mark's cells end in the accent and the wordmark starts bold, in the text colour.
    expect(lines[5]).toContain(`${ACCENT}⣿⣿⣿⡇   ⣠⣴⣿⣿⣿⣷⣆ ⢸⣿⣿⣿\x1b[39m\x1b[1m      ⢸⣿⣿`);
    // The converter's one-dot filler (U+2804) never reaches the terminal as dotted lines.
    expect(lines.join("")).not.toContain("⠄");
    expect(stripAnsi(lines[5]!)).toContain("⢸⣿⣿    ⢹⣿⣿⡆");
  });

  it("is the medium lockup where the large one does not fit, its gap in the same columns", () => {
    for (const [columns, rows] of [
      [80, 40],
      [120, 24],
    ] as const) {
      const lines = renderLogo(style, columns, { indent: "   ", rows });
      expect(lines).toHaveLength(9);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(3 + LOGO_WIDTH);
      expect(lines[3]).toContain(`${ACCENT}⣿⣿  ⣤⣾⣿⡿⠟ ⢸⣿⡇\x1b[39m\x1b[1m   ⣿⣿   ⢀⣿⡏`);
      // Every row of the mark is as wide, so the gap before the wordmark sits in the same three
      // columns on every row that has wordmark, and the wordmark starts right after it.
      for (const cells of lines.map((l) => [...stripAnsi(l)])) {
        if (cells.length <= 3 + 16) continue;
        expect(cells.slice(3 + 13, 3 + 16).join("")).toBe("   ");
      }
      expect([...stripAnsi(lines[2]!)][3 + 16]).toBe("⣿");
    }
  });

  it("is the mark with the name beside it where only that fits, and the name alone without Unicode", () => {
    const narrow = renderLogo(style, 40).map(stripAnsi);
    expect(narrow).toHaveLength(9);
    expect(narrow.filter((line) => line.includes("Pathrule"))).toHaveLength(1);
    expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
    const ascii = terminalStyle({ color: false, unicode: false });
    expect(renderLogo(ascii, 120, { unicode: false, rows: 40 })).toEqual(["* Pathrule"]);
    expect(renderLogo(ascii, 120, { plain: true, rows: 40 })).toEqual(["* Pathrule"]);
  });
});

describe("the rail and long lines", () => {
  it("wraps a line too long for the terminal on the rail, at its indent", () => {
    const out = new Writer(true, 40, 30);
    const runtime = {
      cwd: "/",
      env: {},
      stdout: out,
      stderr: new Writer(),
    } as unknown as CliRuntime;
    const ui = new TerminalUi({
      runtime,
      profile: {
        interactive: true,
        color: false,
        unicode: true,
        cursor: true,
        plain: false,
        columns: 39,
        rows: 30,
      },
      keys: scriptedKeys([]),
    });
    ui.railStart("Pathrule");
    ui.write(["  Found Claude Code and Codex, and also Cursor, OpenCode and Gemini CLI here."]);
    const lines = out.chunks.join("").split("\n").filter(Boolean);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(39);
    expect(lines.slice(2).every((line) => line.startsWith("│    "))).toBe(true);
  });
});
