// SPDX-License-Identifier: Apache-2.0
// Shell command tokenization shared by the open verification-evidence matcher and the
// proprietary bash exploration classifier. Pure: no I/O, no clock, no shell AST.
//
// Best-effort on purpose: it keeps a quoted run together and splits on command separators,
// and anything it gets wrong degrades to an unrecognised token, never to a confident
// misreading. The standalone hook script (`pathrule-hook.js`) carries an inline mirror.

/** Leading tokens that wrap the real command rather than being it. */
export const WRAPPERS: Record<string, true> = {
  sudo: true, command: true, time: true, nohup: true, exec: true, env: true, nice: true,
};

/**
 * Path-ish operands we refuse to report even when a command names them. `/` and `.`
 * are the reason `ls /` must never count as following a route: a token that names
 * the whole tree carries no evidence about WHERE the agent looked.
 */
const TOO_BROAD = new Set(["/", ".", "..", "~", "~/", "*", "**", "./", "../", "-"]);

export function basename(command: string): string {
  const slash = command.lastIndexOf("/");
  return slash === -1 ? command : command.slice(slash + 1);
}

/**
 * Whitespace tokenizer with minimal quote handling. It does NOT implement shell
 * quoting rules, it only keeps a quoted run together so `rg "a b" src` yields three
 * tokens. Anything it gets wrong degrades to an unrecognised token, never to a
 * confident misclassification.
 */
export function tokenizeCommandSegment(segment: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Split a command line into segments on `&&`, `||`, `;`, `|` and newlines.
 *
 * Quote-unaware by design: a separator inside a quoted string produces one extra
 * segment that will not be recognised, which pushes the whole command toward
 * `unknown`. That is the safe direction.
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||[;|]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when a token can be reported as a path operand. */
export function looksLikePath(token: string): boolean {
  if (!token || token.length > 300) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("://")) return false;
  if (TOO_BROAD.has(token)) return false;
  // A glob is a SHAPE, not a location. `find . -name '*.ts'` names no path the agent
  // actually looked at, and `packages/*/src` cannot be matched against a route without
  // expanding it. Both would manufacture route-follow evidence, so neither qualifies.
  if (/[*?[\]{}]/.test(token)) return false;
  // A path either names a directory (has a separator) or a file (has an extension).
  if (token.includes("/")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** Strip a trailing separator so `/packages/app/` and `/packages/app` compare equal. */
export function trimTrailingSlash(token: string): string {
  return token.length > 1 && token.endsWith("/") ? token.slice(0, -1) : token;
}
