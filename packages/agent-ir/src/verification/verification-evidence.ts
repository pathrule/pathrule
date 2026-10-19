// SPDX-License-Identifier: Apache-2.0
/**
 * Verification evidence: answering "did the required verification pass in this session?"
 *
 * Deliberately SEPARATE from the bash exploration classifier's `BashCategory` (Cloud
 * telemetry, not part of this package). That field answers
 * "what kind of work was this call", is tuned for exploration ROI, and its `combine` is
 * conservative on purpose: one unrecognised segment makes the whole line `unknown`,
 * because "I understood half of this" is not evidence about the whole. Correct for
 * telemetry, far too coarse for evidence. Measured on this repo's real commands, 9 of 15
 * came back `unknown` and `node scripts/with-sqlite-native.mjs vitest run`, the actual
 * `test` script of four packages, came back `execution`.
 *
 * Nothing here changes `cat`. It adds one more field.
 *
 * Three rules the whole module is built around:
 *
 *  1. FAIL CLOSED. A command whose pass/fail cannot be attributed to the verification
 *     produces NO signal. A missing signal costs a re-run; a wrong one is a false PASS,
 *     and a false PASS is the only outcome that makes this channel worse than nothing.
 *
 *  2. NO RAW COMMAND, NO ABSOLUTE PATHS. The fingerprint carries a runner name, a script
 *     name and a workspace-relative or package-name scope. An absolute path, a `~` path
 *     or a glob as the scope means the scope cannot be named, and an unnamed scope would
 *     collide with a different package's run, so those produce no signal either.
 *
 *  3. READABLE, NOT HASHED. A hash would be smaller and just as private, but the last
 *     six rounds of this work were only possible because the telemetry could be read by
 *     eye. `vitest@dir:packages/shared` is inspectable; a hash is a promise.
 *
 * WHAT A FINGERPRINT CLAIMS, AND WHAT IT DOES NOT.
 *
 * It claims IDENTITY: this invocation is stably the same logical command as that one,
 * and its exit code belongs to it. It does NOT claim the command is a verification.
 * Nothing here can know that, and the attempt to know it was a measured bug.
 *
 * Measured on this repo's 149 real package.json scripts: the name `build` appears ten
 * times, and it is a pure `tsup` in @pathrule/admin while in @pathrule/web it is four
 * `scripts/check-*.mjs` runs plus a bundle-budget check. Same name, opposite meaning, so
 * a name-keyword list cannot be right in principle. And `build-storybook`, whose
 * greenness a project rule makes a merge gate, is `storybook build --disable-telemetry`:
 * no verification signal in the name OR the body, so no repo-local deterministic signal
 * can promote it either.
 *
 * The judgement therefore belongs where it already lives: a CHECK atom is enforceable
 * only after an explicit human approval, and that approval is the assertion that the
 * named command is the verification. Re-deriving it here rejected two commands a person
 * had correctly named (`pnpm --filter @pathrule/app build-storybook`,
 * `pnpm web:prod-security`) and prevented the CHECK from existing at all.
 *
 * Removing that gate does not open a false-PASS path. A required fingerprint is matched
 * exactly, so a different script's identity cannot satisfy it, and the exit-code rules
 * below are untouched.
 */

import { WRAPPERS, splitCommandSegments, tokenizeCommandSegment } from "./bash-tokens.js";

export interface VerificationSignal {
  /**
   * Stable, path-free identity of the logical verification.
   * Shape: `<runner>[:<target>][@<scope_kind>:<scope>][#narrowed]`
   */
  fingerprint: string;
  /** The tool that does the verifying: "vitest", "pnpm", "pytest", … */
  runner: string;
  /** Named script the command ran, when it ran one: "test", "test:runtime", "db:test". */
  target: string | null;
  /** What the verification covers, as written and normalised. */
  scope: string | null;
  /** How to read `scope`. `null` only when there is no scope at all. */
  scope_kind: "package" | "dir" | "recursive" | null;
  /**
   * True when the run was narrowed to named files. A narrowed run is real evidence about
   * those files and NO evidence about the suite, so it must never satisfy a suite-level
   * requirement. That is why it is in the fingerprint rather than beside it.
   */
  narrowed: boolean;
}

/** Test runners recognised as verification on their own. */
const RUNNERS: Record<string, true> = {
  vitest: true, jest: true, pytest: true, mocha: true, ava: true, playwright: true,
  cypress: true, tap: true, karma: true, nyc: true,
};

/** Programs that commonly wrap a runner (`node scripts/x.mjs vitest run`). */
const RUNNER_WRAPPERS: Record<string, true> = { node: true, tsx: true, bun: true, deno: true };

const PACKAGE_MANAGERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, npx: true, pnpx: true };


/**
 * Flags that put a runner into watch mode, so it never produces a one-shot verdict.
 * Detectable from the invocation itself, which is all this function sees. A script NAMED
 * `test:watch` is not detectable here: its body lives in package.json, which the hook
 * does not read. That hole is unchanged by this file and is recorded as such.
 */
const WATCH_FLAGS = new Set(["--watch", "-w", "--watchAll", "--watch-all"]);

/** Subcommands that mean "run the named script that follows". */
const RUN_SUBCOMMANDS: Record<string, true> = { run: true, exec: true, dlx: true };

/** Flags that take a separate value, so the value is not the subcommand. */
const VALUE_FLAGS: Record<string, true> = { "--filter": true, "-F": true, "--dir": true, "-C": true, "--workspace": true };

const MAX_COMMAND_CHARS = 4000;
const MAX_SCOPE_CHARS = 120;

/** A runner's own subcommands, which are not file arguments. */
const RUNNER_SUBCOMMANDS: Record<string, true> = { run: true, watch: true, related: true, bench: true };

/**
 * Runners that WATCH unless told to run once. Without this, `pnpm vitest` (watch) and
 * `pnpm vitest run` (one shot) produced the SAME fingerprint, so a watch session could
 * satisfy a requirement naming the one-shot suite. That is a false PASS, which is the
 * one outcome this channel must never produce.
 */
const WATCH_BY_DEFAULT: Record<string, true> = { vitest: true };

/** Does the invocation of a watch-by-default runner ask for a single run? */
function asksForSingleRun(rest: string[]): boolean {
  return rest.some((t) => t === "run" || t === "--run");
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/** A script name is a valid identity as long as it is a plausible script token. */
function isScriptToken(name: string): boolean {
  return Boolean(name) && name.length <= 80 && !name.startsWith("-");
}

/**
 * Normalise a scope token, or return null when it cannot be named safely.
 *
 * Rejects absolute paths, `~` paths and globs. This is the same posture the hook's path
 * telemetry already took after it was caught turning `/Users/<name>/x` into
 * `Users/<name>/x` by stripping the leading slash: a path that cannot be expressed
 * workspace-relatively is dropped, never mangled into something that looks relative.
 */
function normaliseScope(raw: string | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().replace(/^["']|["']$/g, "");
  if (!token || token.length > MAX_SCOPE_CHARS) return null;
  if (token.startsWith("/") || token.startsWith("~")) return null;
  if (token.includes("://")) return null;
  if (/[*?[\]{}]/.test(token)) return null;
  if (token === "." || token === "..") return null;
  const trimmed = token.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** A scope token that names a workspace package rather than a directory. */
function looksLikePackageName(token: string): boolean {
  if (token.startsWith("@")) return true;
  return !token.includes("/");
}

interface Segment {
  tokens: string[];
  family: string;
  rest: string[];
}

function peel(segment: string): Segment | null {
  const tokens = tokenizeCommandSegment(segment).filter((t) => !/^\d?>{1,2}/.test(t) && t !== "&>");
  let head = 0;
  while (head < tokens.length) {
    const t = tokens[head]!;
    if (WRAPPERS[basename(t)] === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) head += 1;
    else break;
  }
  if (head >= tokens.length) return null;
  return { tokens, family: basename(tokens[head]!), rest: tokens.slice(head + 1) };
}

/** Bare (non-flag) tokens, with the values of value-taking flags removed. */
function bareTokens(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (VALUE_FLAGS[t] === true) {
      i += 1; // its value is not a positional
      continue;
    }
    if (t.startsWith("-")) continue;
    out.push(t);
  }
  return out;
}

/** Read `--filter X` / `-F X` / `--filter=X`, and the recursive flag. */
function readScopeFlags(rest: string[]): { scope: string | null; kind: "package" | "dir" | "recursive" | null; poisoned: boolean } {
  let recursive = false;
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t === "-r" || t === "--recursive") {
      recursive = true;
      continue;
    }
    const inline = /^(--filter|--workspace|--dir)=(.*)$/.exec(t);
    const raw = inline ? inline[2] : VALUE_FLAGS[t] === true ? rest[i + 1] : undefined;
    if (raw === undefined) continue;
    const scope = normaliseScope(raw);
    // A filter was given but cannot be named: the scope is real and unrepresentable, so
    // a scopeless fingerprint would silently collide with a different package's run.
    if (scope === null) return { scope: null, kind: null, poisoned: true };
    return { scope, kind: looksLikePackageName(scope) ? "package" : "dir", poisoned: false };
  }
  return recursive ? { scope: null, kind: "recursive", poisoned: false } : { scope: null, kind: null, poisoned: false };
}

interface RunnerHit {
  runner: string;
  target: string | null;
  narrowed: boolean;
  /** New concrete runners retain all accepted arguments instead of a shared #narrowed identity. */
  concrete?: true;
}

/** The legacy tokenizer erases empty quotes and cannot reject unmatched ones. */
function concreteQuotesValid(command: string): boolean {
  let quote: string | null = null;
  let opened = -1;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) {
        if (index === opened + 1) return false;
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      opened = index;
    }
  }
  return quote === null;
}

function concreteArgument(token: string, goPackage = false): boolean {
  if (!token || token.length > 120 || !/^[A-Za-z0-9_.:/@=,+^-]+$/.test(token) || token.startsWith("/") || token.startsWith("~") || token.includes("://") || /^[A-Za-z]:/.test(token)) return false;
  if (token.split("/").includes("..")) return false;
  if (token.includes("...")) {
    if (!goPackage || !token.endsWith("/...")) return false;
    const prefix = token.slice(0, -4);
    return prefix === "." || Boolean(prefix) && !prefix.includes("...") && prefix.split("/").every(part => part !== ".." && part !== "");
  }
  return true;
}

const CONCRETE_RUNNER_FLAGS = {
  pytest: {
    boolean: new Set(["-q", "--quiet", "-v", "--verbose", "-x", "--exitfirst", "--disable-warnings", "--strict-markers", "--strict-config", "--no-header", "--no-summary"]),
    value: new Set(["-k", "-m", "--maxfail", "--tb", "--color", "--rootdir", "-c", "--confcutdir", "--import-mode"]),
  },
  cargo: {
    boolean: new Set(["--locked", "--offline", "--frozen", "--workspace", "--all", "--all-features", "--no-default-features", "--lib", "--bins", "--examples", "--tests", "--benches", "--doc", "--release", "--no-fail-fast", "-q", "--quiet", "-v", "--verbose"]),
    value: new Set(["-p", "--package", "--test", "--bin", "--example", "--bench", "--features", "--target", "-j", "--jobs", "--manifest-path", "--exclude"]),
  },
  go: {
    boolean: new Set(["-race", "-short", "-v", "-failfast", "-json"]),
    value: new Set(["-count", "-run", "-bench", "-timeout", "-cpu", "-parallel", "-p", "-tags", "-mod", "-modfile", "-vet", "-shuffle"]),
  },
} as const;

// Built-in Node tests are an exact argv identity, never an opaque script alias.
function nodeTestRunner(seg: Segment): RunnerHit | null {
  const { family, rest, tokens } = seg;
  if (family !== "node" || tokens[0] !== "node" || tokens.length !== rest.length + 1 || rest[0] !== "--test") return null;
  const args = rest.slice(1);
  // Admit only default discovery or concrete relative JS test files. Runtime flags,
  // loaders, globs and program arguments need separate semantics before admission.
  if (args.join(" ").length > 300 || args.some((token: string) => !concreteArgument(token) || token.startsWith("-") || !/^[A-Za-z0-9_./-]+\.(?:js|mjs|cjs)$/.test(token))) return null;
  return { runner: "node", target: `test[${args.map((token: string) => encodeURIComponent(token)).join(",")}]`, narrowed: args.length > 0, concrete: true };
}

function concreteRunner(seg: Segment): RunnerHit | null {
  const { family, rest, tokens } = seg;
  const python = family === "python" || family === "python3";
  const kind = python && rest[0] === "-m" && rest[1] === "pytest" ? "pytest" : (family === "cargo" || family === "go") && rest[0] === "test" ? family : null;
  if (!kind) return null;
  const head = tokens.length - rest.length - 1;
  // Do not erase interpreter paths, environment assignments or privilege-changing wrappers.
  if (head !== 0 || tokens[head] !== family) return null;
  const args = rest.slice(python ? 2 : 1), flags = CONCRETE_RUNNER_FLAGS[kind];
  if (args.join(" ").length > 300) return null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (flags.boolean.has(token)) continue;
    if (token.startsWith("-")) {
      const equal = token.indexOf("="), flag = equal === -1 ? token : token.slice(0, equal);
      if (!flags.value.has(flag)) return null;
      const value = equal === -1 ? args[++index] : token.slice(equal + 1);
      if (!value || value.startsWith("-") || !concreteArgument(value)) return null;
    } else if (!concreteArgument(token, kind === "go")) return null;
  }
  // Percent-encoded token boundaries are readable and collision-free, with no absolute path.
  // Flag order is retained conservatively; an equivalent spelling may require another observed run.
  return { runner: family, target: `${kind === "pytest" ? "pytest" : "test"}[${args.map(token => encodeURIComponent(token)).join(",")}]`, narrowed: args.length > 0, concrete: true };
}

/** Positional file arguments after a runner mean the run was narrowed. */
function isNarrowed(after: string[]): boolean {
  return after.some((t) => !RUNNER_SUBCOMMANDS[t]);
}

function classifySegmentRunner(seg: Segment): RunnerHit | null {
  const { family, rest } = seg;

  if (family === "node" && rest[0] === "--test") return nodeTestRunner(seg);
  if (family === "python" || family === "python3" || family === "cargo" || family === "go") return concreteRunner(seg);

  if (RUNNERS[family] === true) {
    if (WATCH_BY_DEFAULT[family] === true && !asksForSingleRun(rest)) return null;
    return { runner: family, target: null, narrowed: isNarrowed(bareTokens(rest)) };
  }

  if (PACKAGE_MANAGERS[family] === true) {
    const bare = bareTokens(rest);
    const sub = bare[0];
    if (!sub) return null;

    if (RUNNERS[sub] === true) {
      if (WATCH_BY_DEFAULT[sub] === true && !asksForSingleRun(rest)) return null;
      return { runner: sub, target: null, narrowed: isNarrowed(bare.slice(1)) };
    }
    if (RUN_SUBCOMMANDS[sub] === true) {
      const named = bare[1];
      if (!named) return null;
      if (RUNNERS[named] === true) {
        if (WATCH_BY_DEFAULT[named] === true && !asksForSingleRun(rest)) return null;
        return { runner: named, target: null, narrowed: isNarrowed(bare.slice(2)) };
      }
      if (!isScriptToken(named)) return null;
      // A script's body is not read here, so extra positionals after it are opaque and
      // cannot be judged as narrowing.
      return { runner: family, target: named, narrowed: false };
    }
    if (isScriptToken(sub)) {
      return { runner: family, target: sub, narrowed: false };
    }
    return null;
  }

  // `node scripts/with-sqlite-native.mjs vitest run` is the real `test` script of four
  // packages here. The wrapper is opaque; the runner it hands off to is not.
  if (RUNNER_WRAPPERS[family] === true) {
    const bare = bareTokens(rest);
    const index = bare.findIndex((t) => RUNNERS[basename(t)] === true);
    if (index === -1) return null;
    const wrapped = basename(bare[index]!);
    if (WATCH_BY_DEFAULT[wrapped] === true && !asksForSingleRun(rest)) return null;
    return { runner: wrapped, target: null, narrowed: isNarrowed(bare.slice(index + 1)) };
  }

  return null;
}

function buildFingerprint(hit: RunnerHit, scope: string | null, kind: VerificationSignal["scope_kind"]): string {
  const head = hit.target ? `${hit.runner}:${hit.target}` : hit.runner;
  const scopePart = kind === "recursive" ? "@recursive" : kind && scope ? `@${kind}:${scope}` : "";
  return `${head}${scopePart}${hit.narrowed ? "#narrowed" : ""}`;
}

/**
 * Identify the verification a bash command performs, or null.
 *
 * Returns null, on purpose, for:
 *  - anything with a pipe. `pnpm test 2>&1 | tail -20` exits with tail's status, so a
 *    FAILING suite reports success. That is a false PASS, and no classifier can repair
 *    it: the information is gone before the exit code is taken.
 *  - more than one verification in one line. `ok` is a single value and attributing it
 *    to two runs needs the separator semantics this deliberately does not model.
 *  - a scope that exists but cannot be named safely (absolute path, `~`, glob).
 */
export function classifyVerificationCommand(command: unknown): VerificationSignal | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  const bounded = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;

  // Pipes break exit-code attribution. `||` too, and it contains `|`.
  if (bounded.includes("|")) return null;

  // A watch-mode run never terminates, so its exit code says nothing about the code
  // under test.
  if (bounded.split(/\s+/).some((t) => WATCH_FLAGS.has(t))) return null;

  // A watch-mode run does not terminate, so its exit code says nothing about the code
  // under test. Measured hole this closes: `pnpm test:watch` is `vitest` with no `run`,
  // and the old gate accepted it because the NAME contained "test".
  const rawTokens = bounded.split(/\s+/);
  if (rawTokens.some((t) => WATCH_FLAGS.has(t))) return null;

  const segments = splitCommandSegments(bounded);
  if (segments.length === 0) return null;

  let dirScope: string | null = null;
  let dirScopePoisoned = false;
  let hit: RunnerHit | null = null;
  let hitSegment: Segment | null = null;
  let hitCount = 0;

  for (const raw of segments) {
    const seg = peel(raw);
    if (!seg) continue;

    if (seg.family === "cd" || seg.family === "pushd") {
      const target = bareTokens(seg.rest)[0];
      const scope = normaliseScope(target);
      if (scope === null) dirScopePoisoned = true;
      else dirScope = scope;
      continue;
    }

    const found = classifySegmentRunner(seg);
    if (found) {
      hitCount += 1;
      hit = found;
      hitSegment = seg;
    }
  }

  if (!hit || !hitSegment || hitCount !== 1) return null;

  if (hit.concrete) {
    // New runner identities never reinterpret shell redirection, substitution, backgrounding
    // or a later command's exit status as the verification's result.
    if (command.length > MAX_COMMAND_CHARS || /[<>`$\\;\n\r]/.test(bounded) || !concreteQuotesValid(bounded)) return null;
    if (segments.length !== 1 && !(segments.length === 2 && /^\s*(?:cd|pushd)\s+[^&]+\s*&&\s*[^&]+$/.test(bounded))) return null;
    if (segments.length === 1 && bounded.includes("&")) return null;
    if (segments.length === 2) {
      const directory = peel(segments[0]!);
      if (!directory || directory.tokens.length !== 2 || !["cd", "pushd"].includes(directory.tokens[0]!) || !concreteArgument(directory.rest[0]!) || normaliseScope(directory.rest[0]) === null) return null;
      if (directory.family === "pushd" && /^[+-]\d+$/.test(directory.rest[0]!)) return null;
    }
  }

  // Their flags are already retained exactly in target; cargo --workspace is a boolean,
  // not the package-manager value flag handled by the legacy scope reader.
  const flagScope = hit.concrete ? {scope:null,kind:null,poisoned:false} : readScopeFlags(hitSegment.rest);
  if (flagScope.poisoned) return null;

  let scope = flagScope.scope;
  let kind = flagScope.kind;
  if (kind === null && dirScope !== null) {
    scope = dirScope;
    kind = "dir";
  }
  // A `cd` whose target could not be named leaves the verification's scope unknown.
  if (kind === null && dirScopePoisoned) return null;

  return {
    fingerprint: buildFingerprint(hit, scope, kind),
    runner: hit.runner,
    target: hit.target,
    scope,
    scope_kind: kind,
    narrowed: hit.narrowed,
  };
}

/** The only ellipsis exemption in CHECK parsing: an actually identified concrete Go test. */
export function isConcreteGoTestCommand(command: string): boolean {
  return classifyVerificationCommand(command)?.runner === "go";
}

/** Synchronous browser-safe SHA-256. The caller supplies bounded ASCII JSON only. */
function verificationSha256(ascii: string): string {
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const padded = new Uint8Array(Math.ceil((ascii.length + 9) / 64) * 64);
  for (let index = 0; index < ascii.length; index++) padded[index] = ascii.charCodeAt(index);
  padded[ascii.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, ascii.length * 8);
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const previous = words[index - 15]!, recent = words[index - 2]!;
      words[index] = words[index - 16]! + (rotate(previous,7) ^ rotate(previous,18) ^ (previous >>> 3)) + words[index - 7]! + (rotate(recent,17) ^ rotate(recent,19) ^ (recent >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = state as [number,number,number,number,number,number,number,number];
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[index]! + words[index]!) | 0;
      const second = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h=g;g=f;f=e;e=(d+first)|0;d=c;c=b;b=a;a=(first+second)|0;
    }
    for (const [index,value] of [a,b,c,d,e,f,g,h].entries()) state[index] = (state[index]! + value) >>> 0;
  }
  return state.map(value => value.toString(16).padStart(8,"0")).join("");
}

export interface VerificationEvidenceSignal {
  /** Versioned exact-argv digest; no command, environment value or absolute path is logged. */
  fingerprint: string;
  /** Compatibility identity only. It is never sufficient evidence of a PASS. */
  legacyFingerprint: string;
}

/**
 * An unfamiliar project binary can have an exact identity without asserting that its
 * result verifies anything. It is usable as a CHECK only after explicit human approval.
 * The narrow grammar leaves no shell, wrapper, interpolation, path-to-executable,
 * dynamic argument or placeholder semantics to attribute incorrectly. Every wrapper is
 * refused as the binary: `nohup nice` peeled to nothing and threw instead of failing closed.
 */
const OPAQUE_REFUSED_BINARIES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "eval", "xargs", "watch", "git", "cat", "rm", "python", "python3", "cargo", "go"]);
function opaqueStandaloneTokens(command: string): string[] | null {
  if (command.length > 300 || !/^[A-Za-z][A-Za-z0-9_-]{1,63}(?: [A-Za-z0-9_.@=,+^-]+){1,16}$/.test(command)) return null;
  const tokens = command.split(" "), binary = tokens[0]!;
  if (PACKAGE_MANAGERS[binary] || RUNNERS[binary] || RUNNER_WRAPPERS[binary] || WRAPPERS[binary] || OPAQUE_REFUSED_BINARIES.has(binary)) return null;
  if (tokens.slice(1).some(token => token === "--" || token.includes("..") || WATCH_FLAGS.has(token) || /^--?watch(?:=|$)/.test(token) || !concreteArgument(token))) return null;
  return tokens;
}

/** Absence of an error is not an observed successful exit. */
export function confirmedVerificationResult(response: unknown, failureEvent = false, explicitSuccessAttested = false): boolean | null {
  if (failureEvent) return false;
  if (!response || typeof response !== "object") return null;
  const result = response as Record<string,unknown>;
  if (result.error || result.is_error === true || result.interrupted === true || result.signal) return false;
  if ("exit_code" in result) return typeof result.exit_code === "number" && Number.isInteger(result.exit_code) ? result.exit_code === 0 : null;
  return explicitSuccessAttested && result.is_error === false ? true : null;
}

/** Strict evidence is separate from the approved atom's persisted legacy identity. */
export function classifyVerificationEvidenceCommand(command: unknown): VerificationEvidenceSignal | null {
  if (typeof command !== "string" || command.length > MAX_COMMAND_CHARS || /[|;<>`$\\\n\r]/.test(command) || !concreteQuotesValid(command)) return null;
  const legacy = classifyVerificationCommand(command);
  const opaque = legacy ? null : opaqueStandaloneTokens(command);
  if (!legacy && !opaque) return null;
  const segments = splitCommandSegments(command);
  if (segments.length !== 1 && !(segments.length === 2 && /^\s*(?:cd|pushd)\s+[^&]+\s*&&\s*[^&]+$/.test(command))) return null;
  if (segments.length === 1 && command.includes("&")) return null;
  const tokens = segments.map(segment => tokenizeCommandSegment(segment));
  if (tokens.some(segment => segment.some(token => !concreteArgument(token, legacy?.runner === "go")))) return null;
  if (segments.length === 2) {
    const directory = tokens[0]!;
    if (directory.length !== 2 || !["cd","pushd"].includes(directory[0]!) || normaliseScope(directory[1]) === null) return null;
    if (directory[0] === "pushd" && /^[+-]\d+$/.test(directory[1]!)) return null;
  }
  // Only the documented package-filter spellings are canonical aliases; all other
  // arguments, wrappers, interpreter/script tokens and repeated scopes retain order.
  const invocation = tokens[tokens.length - 1]!;
  const peeled = peel(segments[segments.length - 1]!);
  if (!peeled) return null;
  const head = invocation.length - peeled.rest.length - 1;
  const optionPositions = new Set<number>();
  if (PACKAGE_MANAGERS[peeled.family]) {
    let index = head + 1;
    while (index < invocation.length && invocation[index]!.startsWith("-") && invocation[index] !== "--") {
      optionPositions.add(index);
      index += VALUE_FLAGS[invocation[index]!] ? 2 : 1;
    }
  }
  const canonical: string[] = [];
  for (const [index,token] of invocation.entries()) {
    if (optionPositions.has(index) && token === "-F") canonical.push("--filter");
    else if (optionPositions.has(index) && token.startsWith("--filter=")) canonical.push("--filter",token.slice(9));
    else canonical.push(token);
  }
  const identity = tokens.length === 2 ? [tokens[0],canonical] : [canonical];
  return {fingerprint:"verification.v2:" + verificationSha256(JSON.stringify(identity)),legacyFingerprint:legacy?.fingerprint ?? "opaque.v1:"+verificationSha256(JSON.stringify(opaque))};
}

// ─── Session-level evidence ──────────────────────────────────────────────────

/** One logical verification as the session observed it. */
export interface VerificationOutcome {
  fingerprint: string;
  runs: number;
  /** Last observed result. A later failure supersedes an earlier pass. */
  passed: boolean;
  last_at: string | null;
}

/** The subset of an outcome row this reads. Keeps the module independent of the full shape. */
export interface VerificationRow {
  /** Verification fingerprint, written by the hook for bash calls. */
  v?: unknown;
  /** Strict versioned evidence. Old lossy v observations alone cannot confirm a PASS. */
  v2?: unknown;
  /** Explicit verification result, separate from generic tool telemetry success. */
  verificationOk?: unknown;
  /** 1 = success, 0 = failure. */
  ok?: unknown;
  /** ISO timestamp. */
  at?: unknown;
}

/**
 * Fold a session's rows into one outcome per fingerprint.
 *
 * LAST result wins rather than "any pass". A suite that passed and then failed after a
 * further edit has not passed, and "any pass in the session" is exactly the indicator
 * that cannot tell those two apart.
 */
export function collectSessionVerifications(rows: readonly VerificationRow[]): VerificationOutcome[] {
  const byFingerprint = new Map<string, VerificationOutcome>();
  for (const row of rows) {
    const fingerprint = typeof row.v2 === "string" && /^verification\.v2:[0-9a-f]{64}$/.test(row.v2) ? row.v2 : null;
    if (!fingerprint) continue;
    const at = typeof row.at === "string" ? row.at : null;
    const passed = row.verificationOk === true;
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, { fingerprint, runs: 1, passed, last_at: at });
      continue;
    }
    existing.runs += 1;
    existing.passed = passed;
    existing.last_at = at ?? existing.last_at;
  }
  return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * Did the verification a required command names pass in this session?
 *
 * The required command is fingerprinted the same way the observed one was, so the
 * comparison is between two canonical forms and never between two command strings.
 * An unrecognisable requirement answers `false`: a requirement that cannot be
 * fingerprinted can never be satisfied, and saying otherwise would satisfy it by
 * accident.
 */
export function requiredVerificationPassed(
  requiredCommand: string,
  rows: readonly VerificationRow[],
): { known: boolean; passed: boolean; fingerprint: string | null } {
  const required = classifyVerificationEvidenceCommand(requiredCommand);
  if (!required) return { known: false, passed: false, fingerprint: null };
  const match = collectSessionVerifications(rows).find((o) => o.fingerprint === required.fingerprint);
  return { known: true, passed: match?.passed === true, fingerprint: required.fingerprint };
}
