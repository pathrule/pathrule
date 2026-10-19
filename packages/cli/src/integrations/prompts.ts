// SPDX-License-Identifier: Apache-2.0
// Terminal questions for the integrations wizard. With a real terminal: arrow keys (or j/k) move,
// Space toggles, Enter confirms, Esc or Ctrl-C cancels. Without one (a test, a pipe with a
// `promptLine`), the same questions are asked as numbered lines.
import { createInterface } from "node:readline/promises";

import type { CliOutputMode } from "../output.js";
import type { CliRuntime } from "../plugin.js";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

function styles(mode: CliOutputMode) {
  return {
    accent: mode.color ? "\x1b[36m" : "",
    dim: mode.color ? "\x1b[2m" : "",
    bold: mode.color ? "\x1b[1m" : "",
    reset: mode.color ? "\x1b[0m" : "",
  };
}

const SGR = /^\x1b\[[0-9;]*m/;

/**
 * `line` cut to fit one terminal row (`columns - 1` visible characters, colour codes kept). A row
 * that wraps takes two lines, and the redraw, which moves up one line per choice, would then leave
 * a stale line behind on every key.
 */
export function fitLine(line: string, columns: number | undefined): string {
  const width = Math.max(10, (columns && columns > 0 ? columns : 80) - 1);
  if (line.replace(/\x1b\[[0-9;]*m/g, "").length <= width) return line;
  let out = "";
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const code = SGR.exec(line.slice(i));
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    if (visible === width - 1) break;
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${line.includes("\x1b[") ? "\x1b[0m" : ""}`;
}

function rawTerminal(runtime: CliRuntime): boolean {
  return !runtime.promptLine && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const cancelled = (err: unknown) =>
  err instanceof Error && ((err as NodeJS.ErrnoException).code === "ABORT_ERR" || err.name === "AbortError");

/** One typed answer, or null when the person cancels (Ctrl-C at the question). */
async function askLine(runtime: CliRuntime, prompt: string): Promise<string | null> {
  try {
    if (runtime.promptLine) return await runtime.promptLine(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  } catch (err) {
    if (cancelled(err)) {
      runtime.stdout.write("\n");
      return null;
    }
    throw err;
  }
}

async function withKeys<T>(
  runtime: CliRuntime,
  draw: (first: boolean) => void,
  onKey: (key: string) => { done: true; value: T | null } | { done: false },
): Promise<T | null> {
  const stdin = process.stdin;
  draw(true);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<T | null>((resolve) => {
      const onData = (chunk: Buffer | string) => {
        const key = chunk.toString("utf8");
        if (key === "\u0003" || key === "\u001b") {
          stdin.off("data", onData);
          resolve(null);
          return;
        }
        const result = onKey(key);
        if (result.done) {
          stdin.off("data", onData);
          resolve(result.value);
          return;
        }
        draw(false);
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    runtime.stdout.write("\n");
  }
}

/** One choice. Null when the person cancels. */
export async function selectOne<T>(
  runtime: CliRuntime,
  mode: CliOutputMode,
  question: string,
  choices: Choice<T>[],
  initial = 0,
): Promise<T | null> {
  const s = styles(mode);
  runtime.stdout.write(`\n${s.bold}${question}${s.reset}\n`);
  if (!rawTerminal(runtime)) {
    choices.forEach((c, i) => runtime.stdout.write(`  ${i + 1}. ${c.label}${c.hint ? ` ${s.dim}${c.hint}${s.reset}` : ""}\n`));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raw = await askLine(runtime, `Choose 1-${choices.length} [${initial + 1}]: `);
      if (raw === null) return null;
      const answer = raw.trim().toLowerCase();
      if (answer === "q") return null;
      const n = answer === "" ? initial + 1 : Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length && !choices[n - 1]!.disabled) return choices[n - 1]!.value;
    }
    return null;
  }
  let selected = initial;
  const draw = (first: boolean) => {
    if (!first) runtime.stdout.write(`\x1b[${choices.length}A`);
    choices.forEach((c, i) => {
      const line = `${i === selected ? `${s.accent}❯ ${c.label}${s.reset}` : `  ${c.label}`}${c.hint ? ` ${s.dim}${c.hint}${s.reset}` : ""}`;
      runtime.stdout.write(`\x1b[2K${fitLine(line, process.stdout.columns)}\n`);
    });
  };
  return withKeys<T>(runtime, draw, (key) => {
    if (key === "\r" || key === "\n") return { done: true, value: choices[selected]!.value };
    if (key === "\u001b[A" || key === "k") selected = Math.max(0, selected - 1);
    else if (key === "\u001b[B" || key === "j") selected = Math.min(choices.length - 1, selected + 1);
    return { done: false };
  });
}

/** Several choices; disabled ones cannot be toggled. Null when the person cancels. */
export async function selectMany<T>(
  runtime: CliRuntime,
  mode: CliOutputMode,
  question: string,
  choices: Choice<T>[],
  initiallySelected: ReadonlySet<number>,
): Promise<T[] | null> {
  const s = styles(mode);
  runtime.stdout.write(`\n${s.bold}${question}${s.reset}\n`);
  const picked = new Set([...initiallySelected].filter((i) => !choices[i]?.disabled));
  if (!rawTerminal(runtime)) {
    choices.forEach((c, i) =>
      runtime.stdout.write(`  ${i + 1}. ${c.label}${c.disabled ? " (not available)" : ""}${c.hint ? ` ${s.dim}${c.hint}${s.reset}` : ""}\n`),
    );
    const fallback = [...picked].map((i) => i + 1).join(",");
    const raw = await askLine(runtime, `Numbers, comma-separated [${fallback}]: `);
    if (raw === null) return null;
    const answer = raw.trim().toLowerCase();
    if (answer === "q") return null;
    const indexes = answer === "" ? [...picked] : answer.split(",").map((x) => Number.parseInt(x.trim(), 10) - 1);
    const values = indexes.filter((i) => choices[i] && !choices[i]!.disabled).map((i) => choices[i]!.value);
    return values;
  }
  let cursor = Math.max(0, choices.findIndex((c) => !c.disabled));
  const draw = (first: boolean) => {
    if (!first) runtime.stdout.write(`\x1b[${choices.length + 1}A`);
    choices.forEach((c, i) => {
      const box = c.disabled ? "   " : picked.has(i) ? "[x]" : "[ ]";
      const label = c.disabled ? `${s.dim}${c.label}${s.reset}` : c.label;
      const line = `${i === cursor ? `${s.accent}❯${s.reset}` : " "} ${box} ${label}${c.hint ? ` ${s.dim}${c.hint}${s.reset}` : ""}`;
      runtime.stdout.write(`\x1b[2K${fitLine(line, process.stdout.columns)}\n`);
    });
    const help = `${s.dim}  Space to toggle, Enter to continue, Esc to cancel${s.reset}`;
    runtime.stdout.write(`\x1b[2K${fitLine(help, process.stdout.columns)}\n`);
  };
  return withKeys<T[]>(runtime, draw, (key) => {
    if (key === "\r" || key === "\n") return { done: true, value: [...picked].sort((a, b) => a - b).map((i) => choices[i]!.value) };
    if (key === " ") {
      if (!choices[cursor]!.disabled) {
        if (picked.has(cursor)) picked.delete(cursor);
        else picked.add(cursor);
      }
    } else if (key === "\u001b[A" || key === "k") cursor = Math.max(0, cursor - 1);
    else if (key === "\u001b[B" || key === "j") cursor = Math.min(choices.length - 1, cursor + 1);
    return { done: false };
  });
}

/** Yes or no; the default answer is "no" unless said otherwise. Cancelling (Ctrl-C) is always no. */
export async function confirm(runtime: CliRuntime, question: string, defaultYes = false): Promise<boolean> {
  const raw = await askLine(runtime, `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  if (raw === null) return false;
  const answer = raw.trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}
