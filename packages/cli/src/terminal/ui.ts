// SPDX-License-Identifier: Apache-2.0
// One terminal session of the terminal experience: its profile, style, inline screen and keys, and
// the few questions every screen asks (choose one, yes or no, a key to go on). A flow that asks its
// own questions with its own prompts (the integrations wizard, Cloud sign-in, a download) runs
// through `handOff`: the keys give raw mode back and the screen steps aside until it returns.
//
// In plain mode (`PATHRULE_PLAIN=1`) nothing is redrawn: each question is printed once as a
// numbered list and answered with a line and Enter, which a screen reader reads in order.
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";

import type { CliRuntime } from "../plugin.js";
import { parseKeys, type Key, type KeySource } from "./keys.js";
import { terminalKeys } from "./keys.js";
import { spread } from "./box.js";
import { layoutColumns, layoutRows, type TerminalProfile } from "./profile.js";
import { InlineScreen } from "./screen.js";
import { terminalStyle, type Style } from "./style.js";
import { padEnd, stripAnsi, visibleWidth, wrap } from "./text.js";
import { queryBackground, statedTone } from "./theme.js";

export interface ChoiceOption<T> {
  value: T;
  label: string;
  /** A letter that chooses this option at once. */
  key?: string;
  /** Short text beside the label. */
  hint?: string;
  /** Lines under the label, shown for every option (they explain the choice, not the cursor). */
  detail?: string[];
  /** Why this option cannot be chosen now; shown instead of choosing it. */
  disabled?: string;
}

export interface ChoiceQuestion<T> {
  title: string;
  /** Where this question sits in a flow ("step 2 of 3"), beside the title on the rail. */
  step?: string;
  /** Lines between the title and the options. */
  intro?: string[];
  options: ChoiceOption<T>[];
  initial?: number;
  /** Lines under the options, above the key hints. */
  outro?: string[];
}

export interface TerminalUiOptions {
  runtime: CliRuntime;
  profile: TerminalProfile;
  /** The keys to read; by default stdin's, opened on first use. */
  keys?: KeySource;
}

/** The person stopped a flow's own prompt (Ctrl-C). What the flow did before that stays done. */
export class CanceledByPerson extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledByPerson";
  }
}

/**
 * Marks a line that is the rail's own (an active step), so writing it does not put it on the rail
 * a second time. Never printed: takes no cell and is removed before output.
 */
const RAIL_OWN = "\u0000";

function isAbort(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown } | null;
  return e?.code === "ABORT_ERR" || e?.name === "AbortError";
}

export class TerminalUi {
  readonly runtime: CliRuntime;
  readonly screen: InlineScreen;
  /**
   * The setup rail: while on, headings are steps on one vertical line, questions are asked on it
   * and fold to their answer once answered, and written lines sit on it. Plain text ignores it.
   */
  rail = false;
  private profileValue: TerminalProfile;
  private styleValue: Style;
  private keySource: KeySource | null;

  constructor(options: TerminalUiOptions) {
    this.runtime = options.runtime;
    this.profileValue = options.profile;
    this.styleValue = terminalStyle(options.profile);
    this.screen = new InlineScreen(
      options.runtime.stdout,
      options.profile,
      this.styleValue.glyph.ellipsis,
    );
    this.keySource = options.keys ?? null;
  }

  get profile(): TerminalProfile {
    return this.profileValue;
  }

  get style(): Style {
    return this.styleValue;
  }

  /**
   * Asks the terminal whether its background is dark or light, when the environment does not say
   * and the keys are the real terminal's; colours follow the answer. Before the first key is read.
   */
  async detectTone(): Promise<void> {
    const profile = this.profileValue;
    if (this.keySource || !profile.color || !profile.cursor || statedTone(this.runtime.env)) return;
    const tone = await queryBackground(process.stdin, this.runtime.stdout).catch(() => null);
    if (!tone || tone === profile.tone) return;
    this.profileValue = { ...profile, tone };
    this.styleValue = terminalStyle(this.profileValue);
  }

  private get onRail(): boolean {
    return this.rail && !this.profile.plain;
  }

  /** `line` on the rail: the rail's line, two spaces, the text (an empty line is the line alone). */
  private railed(line: string): string {
    const bar = this.style.line(this.style.glyph.rail.line);
    return line ? `${bar}  ${line}` : bar;
  }

  /**
   * Starts the rail: its top with `title` after the brand mark (or, with `brand: false`, as the
   * caller styled it, for a rail under the logo), and `right` flush right.
   */
  railStart(title: string, right = "", options: { brand?: boolean } = {}): void {
    const { style } = this;
    if (this.profile.plain) {
      this.write([title]);
      return;
    }
    this.rail = true;
    const width = Math.min(this.profile.columns, 76);
    // With the brand mark the title is the rail's name, in bold; without it, the caller's words as
    // styled (a logo above already names Pathrule).
    const head =
      options.brand === false
        ? `${style.line(style.glyph.rail.start)}  ${title}`
        : `${style.line(style.glyph.rail.start)}  ${style.accent(style.glyph.brand)} ${style.strong(title)}`;
    this.screen.release();
    this.out.write(`${spread(head, right ? style.dim(right) : "", width)}\n${this.railed("")}\n`);
  }

  /** A step already done, folded to its answer. */
  railDone(title: string, answer: string): void {
    if (!this.onRail) {
      this.write([`${title}: ${answer}`]);
      return;
    }
    this.screen.release();
    this.out.write(`${this.doneLines(title, answer).join("\n")}\n`);
  }

  private doneLines(title: string, answer: string): string[] {
    const { style } = this;
    return [
      `${style.accent(style.glyph.rail.done)}  ${style.dim(title)}`,
      this.railed(answer),
      this.railed(""),
    ];
  }

  /** Ends the rail with `message` beside its end. */
  railEnd(message = ""): void {
    const { style } = this;
    if (!this.onRail) {
      if (message) this.write([message]);
      this.rail = false;
      return;
    }
    this.rail = false;
    this.screen.release();
    this.out.write(`${style.line(style.glyph.rail.end)}  ${message}\n`);
  }

  get out(): Pick<Writable, "write"> {
    return this.runtime.stdout;
  }

  /** Reads the terminal's width again (after a resize). */
  refreshWidth(): void {
    this.profileValue = {
      ...this.profileValue,
      columns: layoutColumns(this.runtime.stdout),
      rows: layoutRows(this.runtime.stdout),
    };
    this.screen.resize(this.profileValue);
  }

  private keys(): KeySource {
    if (!this.keySource) this.keySource = terminalKeys();
    this.keySource.open();
    return this.keySource;
  }

  /** The next key; in plain mode, the first key of a line the person typed (Enter alone: Enter). */
  async key(prompt = "> "): Promise<Key> {
    if (!this.profile.plain) return this.keys().next();
    const line = await this.line(prompt);
    if (line === null) return { name: "eof" };
    return parseKeys(line.trim())[0] ?? { name: "enter" };
  }

  /** One line from the person, or null when input ended. Never in raw mode. */
  async line(prompt: string): Promise<string | null> {
    this.screen.release();
    this.keySource?.close();
    if (this.runtime.promptLine) return this.runtime.promptLine(prompt);
    // Plain mode: no line editing escapes either, only the prompt and the typed line.
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !this.profile.plain,
    });
    try {
      return await new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.question(prompt).then(resolve, () => resolve(null));
      });
    } finally {
      rl.close();
    }
  }

  /**
   * Runs a flow that writes and asks on its own; the screen and the keys step aside meanwhile. A
   * flow's own prompt that the person stops with Ctrl-C (readline's AbortError) becomes a
   * `CanceledByPerson`, which the screens answer with "canceled" rather than a stack trace.
   */
  async handOff<T>(flow: () => Promise<T>): Promise<T> {
    this.screen.release();
    this.keySource?.close();
    try {
      return await flow();
    } catch (err) {
      if (isAbort(err)) throw new CanceledByPerson();
      throw err;
    }
  }

  /** Gives the terminal back for good. */
  close(): void {
    this.screen.release();
    this.keySource?.close();
  }

  /**
   * A heading: bold title over a rule as wide as the screen allows; on the rail, an active step
   * with `step` flush right.
   */
  heading(title: string, step = ""): string[] {
    const { style } = this;
    if (this.profile.plain) return [step ? `${title} (${step})` : title];
    const width = Math.min(this.profile.columns, 76);
    if (this.onRail) {
      const head = `${style.accent(style.glyph.rail.active)}  ${style.strong(title)}`;
      return [`${RAIL_OWN}${spread(head, step ? style.dim(step) : "", width)}`];
    }
    return [style.strong(title), style.line(style.glyph.rule.repeat(width))];
  }

  /** The columns text can use: the rail takes three. */
  private get textWidth(): number {
    return Math.min(this.profile.columns, 96) - (this.onRail ? 3 : 0);
  }

  /** `text` wrapped to the screen with `indent` spaces before every line. */
  paragraph(text: string, indent = 0): string[] {
    const width = Math.max(10, this.textWidth - indent);
    return wrap(text, width).map((line) => `${" ".repeat(indent)}${line}`);
  }

  /** A bulleted item, wrapped with its continuation lines under the text, not the bullet. */
  bullet(text: string, indent = 2): string[] {
    const width = Math.max(10, this.textWidth - indent - 2);
    return wrap(text, width).map(
      (line, i) => `${" ".repeat(indent)}${i === 0 ? `${this.style.glyph.bullet} ` : "  "}${line}`,
    );
  }

  /** One option from a list. Null when the person backs out (Esc, q, Ctrl-C). */
  async choose<T>(question: ChoiceQuestion<T>): Promise<T | null> {
    if (this.profile.plain) return this.chooseByLine(question);
    const { style } = this;
    const enabled = (i: number) => !question.options[i]!.disabled;
    let selected =
      question.initial ??
      Math.max(
        0,
        question.options.findIndex((_, i) => enabled(i)),
      );
    let notice: string | null = null;
    const labelWidth = Math.min(
      28,
      Math.max(...question.options.map((o) => visibleWidth(o.label) + (o.key ? 4 : 0))),
    );
    const rail = this.onRail;
    const render = () => {
      const lines = [...this.heading(question.title, question.step)];
      if (question.intro?.length) lines.push(...question.intro, "");
      question.options.forEach((option, i) => {
        const active = i === selected;
        const pointer = active ? style.accent(style.glyph.pointer) : " ";
        const key = option.key ? `${style.dim(`${option.key}`)}  ` : "";
        const label = active
          ? style.accent(style.strong(option.label))
          : option.disabled
            ? style.dim(option.label)
            : option.label;
        const head = `${pointer} ${key}${label}`;
        lines.push(
          option.hint ? `${padEnd(head, labelWidth + 2)}  ${style.dim(option.hint)}` : head,
        );
        for (const line of option.detail ?? []) {
          for (const wrapped of this.paragraph(line, option.key ? 7 : 4))
            lines.push(style.dim(wrapped));
        }
        if (option.detail?.length && i < question.options.length - 1) lines.push("");
      });
      if (question.outro?.length) lines.push("", ...question.outro);
      lines.push("");
      lines.push(
        notice
          ? style.warn(notice)
          : style.dim(
              `${style.glyph.arrow === "->" ? "up/down" : "↑↓"} move  ${style.glyph.dot}  Enter choose  ${style.glyph.dot}  Esc back`,
            ),
      );
      this.screen.draw(
        rail
          ? [
              lines[0]!.replace(RAIL_OWN, ""),
              ...lines.slice(1).map((line) => this.railed(line)),
              style.line(style.glyph.rail.end),
            ]
          : lines,
      );
    };
    // On the rail an answered question folds to its answer; elsewhere it stays as drawn.
    const settle = (answer: string | null) => {
      if (rail) {
        this.screen.draw(
          answer === null
            ? [
                `${style.dim(style.glyph.rail.done)}  ${style.dim(question.title)}`,
                this.railed(style.dim("not now")),
                this.railed(""),
              ]
            : this.doneLines(question.title, answer),
        );
      }
      this.screen.release();
    };
    render();
    for (;;) {
      const key = await this.key();
      notice = null;
      if (
        key.name === "interrupt" ||
        key.name === "escape" ||
        key.name === "eof" ||
        (key.name === "char" && key.char === "q")
      ) {
        settle(null);
        return null;
      }
      if (key.name === "up" || (key.name === "char" && key.char === "k")) {
        selected = (selected - 1 + question.options.length) % question.options.length;
      } else if (
        key.name === "down" ||
        key.name === "tab" ||
        (key.name === "char" && key.char === "j")
      ) {
        selected = (selected + 1) % question.options.length;
      } else if (key.name === "enter" || key.name === "char") {
        const index =
          key.name === "enter"
            ? selected
            : question.options.findIndex((o) => o.key === key.char) >= 0
              ? question.options.findIndex((o) => o.key === key.char)
              : /^[1-9]$/.test(key.char ?? "")
                ? Number(key.char) - 1
                : -1;
        const option = question.options[index];
        if (option) {
          selected = index;
          if (option.disabled) {
            notice = option.disabled;
          } else {
            if (rail) settle(option.label);
            else {
              render();
              this.screen.release();
            }
            return option.value;
          }
        }
      }
      render();
    }
  }

  /** The plain form of `choose`: a numbered list, then a line. */
  private async chooseByLine<T>(question: ChoiceQuestion<T>): Promise<T | null> {
    const lines = [...this.heading(question.title, question.step)];
    if (question.intro?.length) lines.push(...question.intro);
    question.options.forEach((option, i) => {
      const key = option.key ? ` (${option.key})` : "";
      const hint = option.hint ? `: ${option.hint}` : "";
      const off = option.disabled ? ` [not available: ${option.disabled}]` : "";
      lines.push(`${i + 1}. ${option.label}${key}${hint}${off}`);
      for (const line of option.detail ?? []) lines.push(...this.paragraph(line, 3));
    });
    if (question.outro?.length) lines.push(...question.outro);
    this.write(lines);
    const initial = question.initial ?? 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await this.line(
        `Choose 1-${question.options.length} or a letter, Enter for ${initial + 1}, q to go back: `,
      );
      if (answer === null) return null;
      const text = answer.trim().toLowerCase();
      if (text === "q") return null;
      const index =
        text === ""
          ? initial
          : /^\d+$/.test(text)
            ? Number(text) - 1
            : question.options.findIndex((o) => o.key === text);
      const option = question.options[index];
      if (option && !option.disabled) return option.value;
      this.write([
        option?.disabled ? `Not available: ${option.disabled}` : "Not one of the choices.",
      ]);
    }
    return null;
  }

  /** Yes or no; `defaultYes` decides what Enter means. Esc and Ctrl-C are no. */
  async confirm(question: string, defaultYes = false): Promise<boolean> {
    const { style } = this;
    if (this.profile.plain) {
      const answer = await this.line(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
      const text = (answer ?? "n").trim().toLowerCase();
      return text === "" ? defaultYes : text === "y" || text === "yes";
    }
    const asked = `${style.strong(question)} ${style.dim(defaultYes ? "[Y/n]" : "[y/N]")}`;
    this.screen.draw(
      this.onRail
        ? [`${style.accent(style.glyph.rail.active)}  ${asked}`, style.line(style.glyph.rail.end)]
        : [asked],
    );
    for (;;) {
      const key = await this.key();
      const answer =
        key.name === "enter"
          ? defaultYes
          : key.name === "char" && /^[yY]$/.test(key.char!)
            ? true
            : (key.name === "char" && /^[nNq]$/.test(key.char!)) ||
                key.name === "escape" ||
                key.name === "interrupt" ||
                key.name === "eof"
              ? false
              : null;
      if (answer === null) continue;
      this.screen.draw(
        this.onRail
          ? this.doneLines(question, answer ? style.ok("yes") : "no")
          : [`${style.strong(question)} ${answer ? style.ok("yes") : "no"}`],
      );
      this.screen.release();
      return answer;
    }
  }

  /** Waits for a key after a flow printed its result. Ctrl-C answers false. */
  async pause(message = "Press any key to go back to the home"): Promise<boolean> {
    if (this.profile.plain) {
      const answer = await this.line(`${message.replace(/any key/, "Enter")} (q quits): `);
      return answer !== null && answer.trim().toLowerCase() !== "q";
    }
    this.screen.draw([
      this.onRail ? this.railed(this.style.dim(message)) : this.style.dim(message),
    ]);
    const key = await this.key();
    this.screen.clear();
    return key.name !== "interrupt" && key.name !== "eof";
  }

  /**
   * Lines below the screen; on the rail, on its line, a line too long for the terminal wrapped at
   * its own indent, so the terminal never wraps one across the rail.
   */
  write(lines: readonly string[]): void {
    this.screen.release();
    const room = this.profile.columns - 3;
    const shown = lines.flatMap((line) => {
      if (line.startsWith(RAIL_OWN)) return [line.slice(1)];
      if (!this.onRail) return [line];
      if (visibleWidth(line) <= room) return [this.railed(line)];
      const indent = /^ */.exec(stripAnsi(line))![0];
      return wrap(line.trimStart(), Math.max(10, room - indent.length)).map((part) =>
        this.railed(`${indent}${part}`),
      );
    });
    this.out.write(shown.map((line) => `${line}\n`).join(""));
  }
}
