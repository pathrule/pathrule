// SPDX-License-Identifier: Apache-2.0
// Width-aware text for the terminal screens. A screen line must never be wider than the terminal:
// a wrapped line breaks in-place redraws (the cursor moves up by lines written, not rows shown).
// Widths are counted in terminal cells: escape sequences take none, East Asian wide characters and
// most emoji take two, combining marks take none.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

// Every escape sequence a terminal acts on (CSI in its 7-bit and 8-bit forms, OSC up to BEL or ST,
// DCS/SOS/PM/APC strings, and two-character escapes), then the C0 and C1 controls left, except line
// breaks and tabs.
const ESCAPES =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]?/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Stored text made safe to print: knowledge bodies and activity summaries are written by agents
 * and people, and an escape sequence in them must not move the cursor, retitle the window, or
 * forge a link. Line breaks and tabs stay; every other control goes.
 */
export function terminalSafe(text: string): string {
  return text.replace(ESCAPES, "").replace(CONTROLS, "");
}

function cellWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks and zero-width characters.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** The cells `text` takes in a terminal. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += cellWidth(char.codePointAt(0)!);
  return width;
}

/**
 * `text` cut to `width` cells, ending in `ellipsis` when it was cut. Escape sequences are kept (a
 * style that was open is closed by a reset), so a styled line can be truncated as it is.
 */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const room = Math.max(0, width - visibleWidth(ellipsis));
  let out = "";
  let used = 0;
  let styled = false;
  for (let i = 0; i < text.length; ) {
    ANSI.lastIndex = i;
    const escape = text[i] === "\x1b" ? ANSI.exec(text) : null;
    if (escape && escape.index === i) {
      out += escape[0];
      styled = true;
      i += escape[0].length;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const w = cellWidth(char.codePointAt(0)!);
    if (used + w > room) break;
    out += char;
    used += w;
    i += char.length;
  }
  ANSI.lastIndex = 0;
  return `${out}${styled ? "\x1b[0m" : ""}${ellipsis}`;
}

/** `text` followed by spaces up to `width` cells (never cut). */
export function padEnd(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

/**
 * Plain `text` broken into lines of at most `width` cells at spaces; a word longer than a line is
 * cut. Existing line breaks are kept.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = visibleWidth(word) <= width ? word : truncate(word, width);
    }
    lines.push(line);
  }
  return lines;
}

/** A count with thousands separators, the same in every locale (the screens are English). */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Bytes in the decimal units disks and downloads are sold in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** How long ago `iso` was, coarsely ("just now", "4 min ago", "3 h ago", "2 d ago"). */
export function formatAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** `path` with the home directory shown as `~`. */
export function tildePath(path: string, home: string | undefined): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
