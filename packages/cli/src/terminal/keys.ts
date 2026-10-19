// SPDX-License-Identifier: Apache-2.0
// Keys from a terminal in raw mode, one at a time. The screens read keys through a `KeySource`, so a
// test hands them a script and the real terminal hands them stdin. A source owns raw mode while it
// is open and gives it back when closed, so a flow that asks its own questions (the integrations
// wizard, a sign-in) can run between two screens.
export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "space"
  | "tab"
  | "backspace"
  | "interrupt"
  | "eof"
  | "char";

export interface Key {
  name: KeyName;
  /** The character, for `char`. */
  char?: string;
}

const SEQUENCES: ReadonlyArray<[string, KeyName]> = [
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1bOA", "up"],
  ["\x1bOB", "down"],
  ["\x1bOC", "right"],
  ["\x1bOD", "left"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1b[1~", "home"],
  ["\x1b[4~", "end"],
  ["\r\n", "enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\t", "tab"],
  ["\x7f", "backspace"],
  ["\b", "backspace"],
  ["\x03", "interrupt"],
  ["\x04", "eof"],
  [" ", "space"],
];

// Reports a terminal sends back unasked for a key: an OSC answer (the background colour asked by
// theme.ts, arriving after its wait) or a DCS string. Dropped, so they never become key presses.
const TERMINAL_REPORT = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

/** The keys in one chunk read from a raw terminal (a paste or a fast typist sends several). */
export function parseKeys(raw: string): Key[] {
  const chunk = raw.replace(TERMINAL_REPORT, "");
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const match = SEQUENCES.find(([sequence]) => chunk.startsWith(sequence, i));
    if (match) {
      keys.push({ name: match[1] });
      i += match[0].length;
      continue;
    }
    if (chunk[i] === "\x1b") {
      // An escape sequence this list does not name is skipped whole; a lone Esc is Esc.
      const rest = /^\x1b\[[0-9;]*[~A-Za-z]/.exec(chunk.slice(i));
      if (rest) {
        i += rest[0].length;
        continue;
      }
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }
    const char = String.fromCodePoint(chunk.codePointAt(i)!);
    if (char >= " ") keys.push({ name: "char", char });
    i += char.length;
  }
  return keys;
}

export interface KeySource {
  /** The next key. */
  next(): Promise<Key>;
  /** Gives raw mode back. A closed source can be opened again with `open`. */
  close(): void;
  open(): void;
}

interface RawInput {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Keys from stdin in raw mode, which is on only while the source is open. */
export function terminalKeys(input: RawInput = process.stdin): KeySource {
  const queue: Key[] = [];
  const waiting: Array<(key: Key) => void> = [];
  let opened = false;
  const onData = (chunk: Buffer | string) => {
    for (const key of parseKeys(chunk.toString())) {
      const resolve = waiting.shift();
      if (resolve) resolve(key);
      else queue.push(key);
    }
  };
  const source: KeySource = {
    next() {
      const key = queue.shift();
      if (key) return Promise.resolve(key);
      return new Promise((resolve) => waiting.push(resolve));
    },
    open() {
      if (opened) return;
      opened = true;
      queue.length = 0;
      input.setRawMode?.(true);
      input.on("data", onData);
      input.resume();
    },
    close() {
      if (!opened) return;
      opened = false;
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    },
  };
  source.open();
  return source;
}

/** Keys from a script, for tests: when the script runs out, every read is Ctrl-C. */
export function scriptedKeys(script: Array<Key | string>): KeySource & { reads: number } {
  const keys = script.flatMap((entry) => (typeof entry === "string" ? parseKeys(entry) : [entry]));
  const source = {
    reads: 0,
    next() {
      source.reads += 1;
      return Promise.resolve(keys.shift() ?? { name: "interrupt" as const });
    },
    open() {},
    close() {},
  };
  return source;
}
