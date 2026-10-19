// SPDX-License-Identifier: Apache-2.0
/**
 * The code map: where things are defined in the workspace, so the hook can route an agent to the
 * file and line a prompt is about instead of letting it grep for it.
 *
 * Learned from the code, never a copy of it: only symbol NAMES and their file:line are kept, built
 * locally from the checkout with line-level patterns (JS/TS, Python, Go), no model, no network. It
 * lives in the local hook index next to the checkout it describes and never leaves the machine.
 *
 * Measured on fastify, fastapi and gin (public benchmark v1, turn 10): with knowledge alone the agent
 * still made as many Read/Grep/Glob calls as with no memory at all, because knowledge says WHAT to do,
 * not WHERE the code is. The code map is that missing half.
 *
 * Incremental: a per-file cache keyed by mtime and size, so a sync after an edit re-reads only the
 * files that changed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One symbol: [name, "/path/to/file:line", words]. Words are the lower-case pieces the hook matches. */
export type CodeSymbol = [string, string, string[]];

export interface CodeMap {
  /** Symbols, in file order. Words are base forms. */
  symbols: CodeSymbol[];
  /** Inverse document frequency per base word, rounded, so a rare word outweighs a common one. */
  idf: Record<string, number>;
  /** Other forms of a base word a prompt may use (plural, -ed, -ing) -> the base, so they count once. */
  forms: Record<string, string>;
}

export const CODE_MAP_CACHE_FILE = "code-map-cache.json";
const MAX_FILES = 4000;
const MAX_SYMBOLS = 20000;
const MAX_FILE_BYTES = 512 * 1024;
const SOURCE = /\.(?:[cm]?js|jsx|tsx?|py|go)$/;
const SKIP_DIR = /(?:^|\/)(?:node_modules|\.venv|venv|vendor|coverage|docs?|docs_src|examples?|tests?|__tests__|testdata|fixtures?|\.git)(?:\/|$)/;
const SKIP_FILE = /(?:\.test\.|\.spec\.|\.tst\.|_test\.go$|(?:^|\/)test_[^/]*\.py$|\.d\.ts$|\.min\.js$)/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "super", "else", "do", "try", "with", "new", "typeof"]);

const JS_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*[A-Za-z_$][\w$]*\.prototype\.([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s{2,}(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/,
  // A camelCase key opening an object (Object.defineProperties getters, option tables).
  /^\s{2,}([a-z]+[A-Z][\w$]*)\s*:\s*\{\s*$/,
];
const PY_PATTERNS: RegExp[] = [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/];
const GO_PATTERNS: RegExp[] = [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)\s/];

/** The other forms a prompt may use for a word: singular or plural, -ed, -ing ("validate": "validated"). */
export function wordForms(w: string): string[] {
  const stem = w.endsWith("e") ? w.slice(0, -1) : w;
  return [w.endsWith("s") ? w.slice(0, -1) : `${w}s`, `${stem}ed`, `${stem}ing`].filter((f) => f.length >= 3 && f !== w);
}

/** The lower-case base words of an identifier, the whole name included. */
export function identifierWords(name: string): string[] {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
  return [...new Set<string>([name.toLowerCase(), ...parts])].filter((w) => w.length >= 3);
}

/** Symbols defined in one source file, as [name, line]. */
export function extractSymbols(path: string, text: string): Array<[string, number]> {
  const patterns = path.endsWith(".py") ? PY_PATTERNS : path.endsWith(".go") ? GO_PATTERNS : JS_PATTERNS;
  const out: Array<[string, number]> = [];
  const lines = text.split("\n");
  let goStruct = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (path.endsWith(".go")) {
      // Exported fields of a struct are where Go keeps settings (`Engine.RedirectTrailingSlash`).
      if (/^type\s+\w+\s+struct\s*\{/.test(line)) goStruct = true;
      else if (goStruct && /^\}/.test(line)) goStruct = false;
      else if (goStruct) {
        const f = /^\t([A-Z]\w*)\s+[\w*.[\]]/.exec(line);
        if (f) out.push([f[1]!, i + 1]);
        continue;
      }
    }
    for (const re of patterns) {
      const m = re.exec(line);
      if (m && m[1] && !KEYWORDS.has(m[1])) {
        out.push([m[1], i + 1]);
        break;
      }
    }
  }
  return out;
}

function sourceFiles(root: string): string[] {
  let listed: string[];
  try {
    listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  } catch {
    return [];
  }
  return listed.filter((f) => f && SOURCE.test(f) && !SKIP_DIR.test(f) && !SKIP_FILE.test(f)).slice(0, MAX_FILES);
}

type Cache = Record<string, { m: number; s: number; sym: Array<[string, number]> }>;

/** Build the code map for a checkout, reusing the cache in `cacheDir` for unchanged files. */
export async function buildCodeMap(root: string, cacheDir: string): Promise<CodeMap | null> {
  const files = sourceFiles(root);
  if (files.length === 0) return null;
  const cachePath = join(cacheDir, CODE_MAP_CACHE_FILE);
  let cache: Cache = {};
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8")) as Cache;
  } catch {
    cache = {};
  }
  const next: Cache = {};
  const symbols: CodeSymbol[] = [];
  for (const rel of files) {
    let st;
    try {
      st = statSync(join(root, rel));
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    const hit = cache[rel];
    const sym = hit && hit.m === st.mtimeMs && hit.s === st.size ? hit.sym : extractSymbols(rel, readFileSync(join(root, rel), "utf8"));
    next[rel] = { m: st.mtimeMs, s: st.size, sym };
    for (const [name, line] of sym) {
      if (symbols.length >= MAX_SYMBOLS) break;
      symbols.push([name, `/${rel}:${line}`, identifierWords(name)]);
    }
  }
  await writeFile(cachePath, JSON.stringify(next), { mode: 0o600 }).catch(() => undefined);
  const df = new Map<string, number>();
  for (const [, , words] of symbols) for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
  const idf: Record<string, number> = {};
  const forms: Record<string, string> = {};
  for (const [w, n] of df) idf[w] = Math.round(Math.log((symbols.length + 1) / n) * 10) / 10;
  // A form that is itself a base word stays that word: "options" in a code base with an `options`.
  for (const w of df.keys()) for (const f of wordForms(w)) if (!df.has(f) && !(f in forms)) forms[f] = w;
  return { symbols, idf, forms };
}
