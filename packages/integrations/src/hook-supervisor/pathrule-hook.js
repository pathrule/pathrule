#!/bin/sh
":"; //; NODE_BIN="${PATHRULE_NODE:-$(command -v node 2>/dev/null || true)}"; if [ -z "$NODE_BIN" ]; then for node_path in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /bin/node; do [ -x "$node_path" ] && NODE_BIN="$node_path" && break; done; fi; if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then exec "$NODE_BIN" "$0" "$@"; fi; printf '{}\n'; exit 0
// SPDX-License-Identifier: Apache-2.0
// Pathrule hook supervisor.
// Polyglot bootstrap: when launched by an AI client whose spawn env has no
// `node` on PATH (Claude Code / Cursor on macOS without login shell), `/bin/sh`
// hunts for a node binary in common install locations, then re-execs us. If
// nothing is found we emit `{}` and exit 0 so the client never sees a 127
// "command not found" and the hook becomes a graceful no-op.
//
// In Node, line 2 reads as: `":"` (string literal, no-op) followed by `//`
// line comment, so the shell payload is invisible to the JS runtime.
//
// Installed at ~/.pathrule/bin/pathrule-hook.js. Runs on every hook event an AI
// client's config registers (.claude/settings.json and its equivalents).
//
// The hook observes the agent's events, reads the hook index and delivers what the
// index holds. It produces no intelligence and calls no hosted service. One optional
// extension an installer writes next to it adds the rest (see "Extensions" below): the
// cloud extension ranks over the hosted index and records local telemetry for a Pathrule
// Cloud workspace. Without it, every call site runs its open default; the delivery
// decisions (budget, boosts, order) are fixed ones (`deliveryDecisions`).
//
// Dispatch:
//   SessionStart     → workspace metadata + digest, and the protocol when the index carries it
//   UserPromptSubmit → workspace metadata, project rules, the route and the prompt's bodies
//   PreToolUse       → Read/Edit/Write: path-scoped context, deduped per session
//                      Edit/Write: strict rule BLOCK_PATTERN check (decision:deny)
//   PostToolUse      → CHECK evidence, observation capture, and on error a
//                      fail-patterns.jsonl line
//   Stop/SubagentStop→ the CHECK gate. Each turn ends with Stop, but the
//                      session ledger MUST live across turns or the
//                      USER_PROMPT_REFRESH_EVERY throttle never accumulates.
//   SessionEnd       → delete session state file (true session boundary)
//
// Invariants:
//   - Always exit 0. Never exit 2. Block decisions via JSON `decision: "deny"`.
//   - Any internal error → emit {}, log it, keep Claude running.
//   - No external deps beyond Node built-ins.
//   - Kill switch: ~/.pathrule/kill-hooks → instant pass-through.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const PATHRULE_HOME =
  process.env.PATHRULE_HOME && process.env.PATHRULE_HOME.trim() !== ""
    ? process.env.PATHRULE_HOME
    : path.join(os.homedir(), ".pathrule");
const CACHE_DIR = path.join(PATHRULE_HOME, "cache");
const KILL_SWITCH = path.join(PATHRULE_HOME, "kill-hooks");
const LOG_DIR = path.join(PATHRULE_HOME, "logs");
const SUPERVISOR_CONFIG = path.join(PATHRULE_HOME, "hook-supervisor.json");
// Navigation mode toggle. "off" disables the route block entirely;
// "advisory"/"on" keep the default soft-guidance behavior (navigation is already
// advisory — it never blocks tools). Resolution: env PATHRULE_NAVIGATION wins,
// else `navigation` in hook-supervisor.json, else "on". Read once at load.
// "suppressed" is the RESEARCH mode and exists for exactly one reason: a causal
// routing experiment needs a control arm where the route is computed and recorded but
// not shown. "off" cannot be that arm, because it skips the whole block and takes body
// delivery with it, so an off-vs-on comparison would be measuring two changes at once.
// In "suppressed" the route is selected, the session ledger is updated (so follow-through
// is still detected: did the agent go there ANYWAY), and the telemetry line is written
// with `delivered: false`. Only the injected text is withheld. Never a default: it is
// reachable only through PATHRULE_NAVIGATION or hook-supervisor.json.
const NAVIGATION_MODE = (() => {
  const valid = new Set(["off", "advisory", "on", "suppressed"]);
  const env = (process.env.PATHRULE_NAVIGATION || "").trim().toLowerCase();
  if (valid.has(env)) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(SUPERVISOR_CONFIG, "utf8"));
    const m = typeof cfg.navigation === "string" ? cfg.navigation.trim().toLowerCase() : "";
    if (valid.has(m)) return m;
  } catch {
    /* config absent → default */
  }
  return "on";
})();

// ─── Path comparison (mirrors @pathrule/shared/path-compare.ts) ──────────────
// Inlined because this file ships as standalone JS to ~/.pathrule/bin/ and
// cannot require the TS package. Keep the logic identical to its TS twin —
// any change there must be mirrored here.
const IS_CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function pathCompareKey(p) {
  const trimmed = (process.platform === "win32" ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
  return IS_CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
}

function pathsEqual(a, b) {
  return pathCompareKey(a) === pathCompareKey(b);
}

function pathStartsWith(child, parent) {
  const c = pathCompareKey(child);
  const p = pathCompareKey(parent);
  if (c === p) return true;
  return c.startsWith(p + "/");
}
// ─── Tool names ──────────────────────────────────────────────────────────────
//
// Each client names its tools its own way. The CHECK evidence and the observation
// capture key on one canonical name, and an extension that records an outcome
// receives it already canonical.
// Tool name maps per client.
const M46_CLAUDE_TOOL_MAP = {
  Bash: "bash",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  TodoWrite: "todo_write",
};
const M46_CURSOR_TOOL_MAP = {
  shell_command: "bash",
  run_command: "bash",
  read_file: "read",
  view_file: "read",
  edit_file: "edit",
  write_file: "write",
  search_codebase: "grep",
  list_dir: "glob",
};
// Codex's HOOK payload is a near-clone of Claude's: PascalCase tool names, with
// `apply_patch` standing in for Edit/Write (see client-config-writer.ts, which
// registers exactly `Bash|apply_patch` as the Codex matchers, and event-mapping.ts,
// which leaves `Bash` unmapped). This map used to hold only the OpenAI API tool ids
// (`shell`, `view`), which the hook payload never sends. Measured 2026-09-03: 193 of
// 193 Codex tool events normalised to "other", so that client contributed nothing to
// any per-tool number. The API ids stay for older/other Codex surfaces.
const M46_CODEX_TOOL_MAP = {
  Bash: "bash",
  apply_patch: "edit",
  shell: "bash",
  view: "read",
};
const M46_WINDSURF_TOOL_MAP = {
  run_command: "bash",
  execute_command: "bash",
  view_file: "read",
  read_file: "read",
  write_to_file: "write",
  write_file: "write",
  search_files: "grep",
  find_by_name: "glob",
};

function m46CanonicalToolName(raw, client) {
  if (!raw) return "other";
  let map;
  if (client === "cursor") map = M46_CURSOR_TOOL_MAP;
  else if (client === "codex") map = M46_CODEX_TOOL_MAP;
  else if (client === "windsurf") map = M46_WINDSURF_TOOL_MAP;
  // copilot deliberately falls through to the Claude map: its normalization
  // branch rewrites tool names to Claude canonical form before dispatch.
  else map = M46_CLAUDE_TOOL_MAP;
  if (map[raw]) return map[raw];
  // Codex ships Claude's PascalCase contract with a couple of tool names swapped, so
  // anything its own map does not cover is still a Claude name. Falling through here
  // costs nothing when the name is absent from both and keeps "other" meaning
  // "genuinely unrecognised" rather than "we forgot this client".
  if (client === "codex" && M46_CLAUDE_TOOL_MAP[raw]) return M46_CLAUDE_TOOL_MAP[raw];
  if (client === "claude" && typeof raw === "string" && raw.startsWith("mcp__")) {
    return "mcp_" + raw.slice(5).replace(/__/g, "_");
  }
  return "other";
}
// ─── Shell tokenizer (INLINE MIRROR) ────────────────────────────────────────
//
// Source of truth: @pathrule/agent-ir's verification/bash-tokens.ts. This script ships
// standalone and cannot import it, so the two functions the verification evidence
// below needs are mirrored here, pinned by the verification parity test.
const BASH_MAX_COMMAND_CHARS = 4000;

function bashBasename(cmd) {
  const i = cmd.lastIndexOf("/");
  return i === -1 ? cmd : cmd.slice(i + 1);
}

function bashTokenize(segment) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
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
// Rules carrying a compiled CHECK that apply to this path. Unbudgeted, for the same
// reason the enforcement set is: a requirement that disappears because the rule lost a
// priority race is a gate that silently stops gating.
// Does an edited path fall inside a constraint's path narrowing? Exact or descendant,
// plus the extension filter when one was given. Mirrors constraint-compiler.ts
// `pathMatchesConstraintScope`.
function pathInConstraintScope(filePath, narrowing) {
  if (!filePath || !narrowing || !narrowing.scope_path) return false;
  const pth = filePath.startsWith("/") ? filePath : "/" + filePath;
  const scope = narrowing.scope_path === "/" ? "" : narrowing.scope_path.replace(/\/+$/, "");
  if (scope !== "" && pth !== scope && !pth.startsWith(scope + "/")) return false;
  const exts = Array.isArray(narrowing.file_extensions) ? narrowing.file_extensions : null;
  if (exts && exts.length > 0) {
    const lower = pth.toLowerCase();
    if (!exts.some((ext) => typeof ext === "string" && lower.endsWith(ext))) return false;
  }
  return true;
}

function matchCheckRulesForPath(idx, relativePath) {
  return collectApplicableRules(idx, relativePath).filter((r) => r.required_check != null);
}

// Exact or descendant only, and "/" covers everything. An edit to /packages is not an
// edit inside /packages/shared, and counting ancestors would fire the requirement on
// work the command does not verify. Mirrors check.ts `pathInCheckScope`.
function pathInCheckScope(mutatedPath, scopePath) {
  if (!mutatedPath || !scopePath) return false;
  if (scopePath === "/") return true;
  const pth = mutatedPath.startsWith("/") ? mutatedPath : "/" + mutatedPath;
  const scp = scopePath.replace(/\/+$/, "");
  return pth === scp || pth.startsWith(scp + "/");
}

// ─── Verification evidence ───────────────────────────────────────────────────
// Inline mirror of packages/agent-ir/src/verification/verification-evidence.ts (rationale
// there), kept in step by pathrule-hook-verification-parity.test.ts. Fails closed
// everywhere: a missing signal costs a re-run; a wrong one is a false PASS.
const VERIF_RUNNERS = {
  vitest: true, jest: true, pytest: true, mocha: true, ava: true, playwright: true,
  cypress: true, tap: true, karma: true, nyc: true,
};
const VERIF_RUNNER_WRAPPERS = { node: true, tsx: true, bun: true, deno: true };
const VERIF_PACKAGE_MANAGERS = { npm: true, pnpm: true, yarn: true, npx: true, pnpx: true };
const VERIF_WRAPPERS = {
  sudo: true, command: true, time: true, nohup: true, exec: true, env: true, nice: true,
};
// A fingerprint claims IDENTITY, not that the command verifies anything: that judgement
// belongs to the human approval on the CHECK atom.
const VERIF_WATCH_FLAGS = new Set(["--watch", "-w", "--watchAll", "--watch-all"]);
// Runners that watch unless told to run once: without this, `pnpm vitest` and
// `pnpm vitest run` produced the same fingerprint and a watch session could satisfy a
// requirement naming the one-shot suite.
const VERIF_WATCH_BY_DEFAULT = { vitest: true };
const VERIF_RUN_SUBCOMMANDS = { run: true, exec: true, dlx: true };
const VERIF_VALUE_FLAGS = {
  "--filter": true, "-F": true, "--dir": true, "-C": true, "--workspace": true,
};
const VERIF_RUNNER_SUBCOMMANDS = { run: true, watch: true, related: true, bench: true };
const VERIF_MAX_SCOPE_CHARS = 120;

function verifIsScript(name) {
  return Boolean(name) && name.length <= 80 && !name.startsWith("-");
}

function verifAsksForSingleRun(rest) {
  return rest.some((t) => t === "run" || t === "--run");
}

function verifNormaliseScope(raw) {
  if (!raw) return null;
  const token = String(raw).trim().replace(/^["']|["']$/g, "");
  if (!token || token.length > VERIF_MAX_SCOPE_CHARS) return null;
  if (token.startsWith("/") || token.startsWith("~")) return null;
  if (token.includes("://")) return null;
  if (/[*?[\]{}]/.test(token)) return null;
  if (token === "." || token === "..") return null;
  const trimmed = token.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

function verifPeel(segment) {
  const tokens = bashTokenize(segment).filter((t) => !/^\d?>{1,2}/.test(t) && t !== "&>");
  let head = 0;
  while (head < tokens.length) {
    const t = tokens[head];
    if (VERIF_WRAPPERS[bashBasename(t)] === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) head += 1;
    else break;
  }
  if (head >= tokens.length) return null;
  return { tokens, family: bashBasename(tokens[head]), rest: tokens.slice(head + 1) };
}

function verifBare(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (VERIF_VALUE_FLAGS[t] === true) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) continue;
    out.push(t);
  }
  return out;
}

function verifScopeFlags(rest) {
  let recursive = false;
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === "-r" || t === "--recursive") {
      recursive = true;
      continue;
    }
    const inline = /^(--filter|--workspace|--dir)=(.*)$/.exec(t);
    const raw = inline ? inline[2] : VERIF_VALUE_FLAGS[t] === true ? rest[i + 1] : undefined;
    if (raw === undefined) continue;
    const scope = verifNormaliseScope(raw);
    if (scope === null) return { scope: null, kind: null, poisoned: true };
    const kind = scope.startsWith("@") || !scope.includes("/") ? "package" : "dir";
    return { scope, kind, poisoned: false };
  }
  return recursive
    ? { scope: null, kind: "recursive", poisoned: false }
    : { scope: null, kind: null, poisoned: false };
}

function verifNarrowed(after) {
  return after.some((t) => !VERIF_RUNNER_SUBCOMMANDS[t]);
}

function verifConcreteQuotesValid(command) {
  let quote = null;
  let opened = -1;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
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

function verifConcreteArgument(token, goPackage = false) {
  if (!token || token.length > 120 || !/^[A-Za-z0-9_.:/@=,+^-]+$/.test(token) || token.startsWith("/") || token.startsWith("~") || token.includes("://") || /^[A-Za-z]:/.test(token)) return false;
  if (token.split("/").includes("..")) return false;
  if (token.includes("...")) {
    if (!goPackage || !token.endsWith("/...")) return false;
    const prefix = token.slice(0, -4);
    return prefix === "." || Boolean(prefix) && !prefix.includes("...") && prefix.split("/").every(part => part !== ".." && part !== "");
  }
  return true;
}

const VERIF_CONCRETE_RUNNER_FLAGS = {
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
};

// Built-in Node tests are an exact argv identity, never an opaque script alias.
function verifNodeTestRunner(seg) {
  const { family, rest, tokens } = seg;
  if (family !== "node" || tokens[0] !== "node" || tokens.length !== rest.length + 1 || rest[0] !== "--test") return null;
  const args = rest.slice(1);
  // Admit only default discovery or concrete relative JS test files. Runtime flags,
  // loaders, globs and program arguments need separate semantics before admission.
  if (args.join(" ").length > 300 || args.some((token) => !verifConcreteArgument(token) || token.startsWith("-") || !/^[A-Za-z0-9_./-]+\.(?:js|mjs|cjs)$/.test(token))) return null;
  return { runner: "node", target: `test[${args.map((token) => encodeURIComponent(token)).join(",")}]`, narrowed: args.length > 0, concrete: true };
}

function verifConcreteRunner(seg) {
  const { family, rest, tokens } = seg;
  const python = family === "python" || family === "python3";
  const kind = python && rest[0] === "-m" && rest[1] === "pytest" ? "pytest" : (family === "cargo" || family === "go") && rest[0] === "test" ? family : null;
  if (!kind) return null;
  const head = tokens.length - rest.length - 1;
  // Do not erase interpreter paths, environment assignments or privilege-changing wrappers.
  if (head !== 0 || tokens[head] !== family) return null;
  const args = rest.slice(python ? 2 : 1), flags = VERIF_CONCRETE_RUNNER_FLAGS[kind];
  if (args.join(" ").length > 300) return null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (flags.boolean.has(token)) continue;
    if (token.startsWith("-")) {
      const equal = token.indexOf("="), flag = equal === -1 ? token : token.slice(0, equal);
      if (!flags.value.has(flag)) return null;
      const value = equal === -1 ? args[++index] : token.slice(equal + 1);
      if (!value || value.startsWith("-") || !verifConcreteArgument(value)) return null;
    } else if (!verifConcreteArgument(token, kind === "go")) return null;
  }
  // Percent-encoded token boundaries are readable and collision-free, with no absolute path.
  // Flag order is retained conservatively; an equivalent spelling may require another observed run.
  return { runner: family, target: `${kind === "pytest" ? "pytest" : "test"}[${args.map(token => encodeURIComponent(token)).join(",")}]`, narrowed: args.length > 0, concrete: true };
}

function verifSegmentRunner(seg) {
  const family = seg.family;
  const rest = seg.rest;
  if (family === "node" && rest[0] === "--test") return verifNodeTestRunner(seg);
  if (family === "python" || family === "python3" || family === "cargo" || family === "go") return verifConcreteRunner(seg);
  if (VERIF_RUNNERS[family] === true) {
    if (VERIF_WATCH_BY_DEFAULT[family] === true && !verifAsksForSingleRun(rest)) return null;
    return { runner: family, target: null, narrowed: verifNarrowed(verifBare(rest)) };
  }
  if (VERIF_PACKAGE_MANAGERS[family] === true) {
    const bare = verifBare(rest);
    const sub = bare[0];
    if (!sub) return null;
    if (VERIF_RUNNERS[sub] === true) {
      if (VERIF_WATCH_BY_DEFAULT[sub] === true && !verifAsksForSingleRun(rest)) return null;
      return { runner: sub, target: null, narrowed: verifNarrowed(bare.slice(1)) };
    }
    if (VERIF_RUN_SUBCOMMANDS[sub] === true) {
      const named = bare[1];
      if (!named) return null;
      if (VERIF_RUNNERS[named] === true) {
        if (VERIF_WATCH_BY_DEFAULT[named] === true && !verifAsksForSingleRun(rest)) return null;
        return { runner: named, target: null, narrowed: verifNarrowed(bare.slice(2)) };
      }
      if (!verifIsScript(named)) return null;
      return { runner: family, target: named, narrowed: false };
    }
    if (verifIsScript(sub)) return { runner: family, target: sub, narrowed: false };
    return null;
  }
  if (VERIF_RUNNER_WRAPPERS[family] === true) {
    const bare = verifBare(rest);
    const index = bare.findIndex((t) => VERIF_RUNNERS[bashBasename(t)] === true);
    if (index === -1) return null;
    const wrapped = bashBasename(bare[index]);
    if (VERIF_WATCH_BY_DEFAULT[wrapped] === true && !verifAsksForSingleRun(rest)) return null;
    return {
      runner: wrapped,
      target: null,
      narrowed: verifNarrowed(bare.slice(index + 1)),
    };
  }
  return null;
}

function classifyVerificationCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const bounded =
    command.length > BASH_MAX_COMMAND_CHARS ? command.slice(0, BASH_MAX_COMMAND_CHARS) : command;
  // A pipe moves the exit code to the last stage, so a FAILING suite piped to `tail`
  // would be recorded as a pass. Unrepairable here, so refused.
  if (bounded.includes("|")) return null;
  // A watch-mode run never terminates, so its exit code says nothing.
  if (bounded.split(/\s+/).some((t) => VERIF_WATCH_FLAGS.has(t))) return null;
  const segments = bounded.split(/\n|&&|[;]/g).map((x) => x.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  let dirScope = null;
  let dirPoisoned = false;
  let hit = null;
  let hitSegment = null;
  let hitCount = 0;

  for (const raw of segments) {
    const seg = verifPeel(raw);
    if (!seg) continue;
    if (seg.family === "cd" || seg.family === "pushd") {
      const scope = verifNormaliseScope(verifBare(seg.rest)[0]);
      if (scope === null) dirPoisoned = true;
      else dirScope = scope;
      continue;
    }
    const found = verifSegmentRunner(seg);
    if (found) {
      hitCount += 1;
      hit = found;
      hitSegment = seg;
    }
  }
  if (!hit || !hitSegment || hitCount !== 1) return null;
  if (hit.concrete) {
    if (command.length > BASH_MAX_COMMAND_CHARS || /[<>`$\\;\n\r]/.test(bounded) || !verifConcreteQuotesValid(bounded)) return null;
    if (segments.length !== 1 && !(segments.length === 2 && /^\s*(?:cd|pushd)\s+[^&]+\s*&&\s*[^&]+$/.test(bounded))) return null;
    if (segments.length === 1 && bounded.includes("&")) return null;
    if (segments.length === 2) {
      const directory = verifPeel(segments[0]);
      if (!directory || directory.tokens.length !== 2 || !["cd", "pushd"].includes(directory.tokens[0]) || !verifConcreteArgument(directory.rest[0]) || verifNormaliseScope(directory.rest[0]) === null) return null;
      if (directory.family === "pushd" && /^[+-]\d+$/.test(directory.rest[0])) return null;
    }
  }

  const flagScope = hit.concrete ? {scope:null,kind:null,poisoned:false} : verifScopeFlags(hitSegment.rest);
  if (flagScope.poisoned) return null;
  let scope = flagScope.scope;
  let kind = flagScope.kind;
  if (kind === null && dirScope !== null) {
    scope = dirScope;
    kind = "dir";
  }
  if (kind === null && dirPoisoned) return null;

  const head = hit.target ? hit.runner + ":" + hit.target : hit.runner;
  const scopePart = kind === "recursive" ? "@recursive" : kind && scope ? "@" + kind + ":" + scope : "";
  return head + scopePart + (hit.narrowed ? "#narrowed" : "");
}
// Strict evidence is versioned independently of stored, approved legacy atom identities.
function verifOpaqueStandaloneTokens(command) {
  if (command.length > 300 || !/^[A-Za-z][A-Za-z0-9_-]{1,63}(?: [A-Za-z0-9_.@=,+^-]+){1,16}$/.test(command)) return null;
  const tokens = command.split(" "), binary = tokens[0];
  if (VERIF_PACKAGE_MANAGERS[binary] || VERIF_RUNNERS[binary] || VERIF_RUNNER_WRAPPERS[binary] || VERIF_WRAPPERS[binary]
    || new Set(["sh","bash","zsh","fish","dash","ksh","csh","tcsh","pwsh","eval","xargs","watch","git","cat","rm","python","python3","cargo","go"]).has(binary)) return null;
  if (tokens.slice(1).some(token => token === "--" || token.includes("..") || VERIF_WATCH_FLAGS.has(token) || /^--?watch(?:=|$)/.test(token) || !verifConcreteArgument(token))) return null;
  return tokens;
}
function classifyVerificationEvidenceCommand(command) {
  if (typeof command !== "string" || command.length > BASH_MAX_COMMAND_CHARS || /[|;<>`$\\\n\r]/.test(command) || !verifConcreteQuotesValid(command)) return null;
  const legacy = classifyVerificationCommand(command);
  if (!legacy && !verifOpaqueStandaloneTokens(command)) return null;
  const segments = command.split(/\n|&&|[;]/g).map(segment => segment.trim()).filter(Boolean);
  if (segments.length !== 1 && !(segments.length === 2 && /^\s*(?:cd|pushd)\s+[^&]+\s*&&\s*[^&]+$/.test(command))) return null;
  if (segments.length === 1 && command.includes("&")) return null;
  const tokens = segments.map(segment => bashTokenize(segment));
  const runner = verifPeel(segments[segments.length - 1]);
  if (!runner) return null;
  const hit = verifSegmentRunner(runner);
  if (tokens.some(segment => segment.some(token => !verifConcreteArgument(token, hit?.runner === "go")))) return null;
  if (segments.length === 2) {
    const directory = tokens[0];
    if (directory.length !== 2 || !["cd","pushd"].includes(directory[0]) || verifNormaliseScope(directory[1]) === null) return null;
    if (directory[0] === "pushd" && /^[+-]\d+$/.test(directory[1])) return null;
  }
  const invocation = tokens[tokens.length - 1];
  const head = invocation.length - runner.rest.length - 1;
  const optionPositions = new Set();
  if (VERIF_PACKAGE_MANAGERS[runner.family]) {
    let index = head + 1;
    while (index < invocation.length && invocation[index].startsWith("-") && invocation[index] !== "--") {
      optionPositions.add(index);
      index += VERIF_VALUE_FLAGS[invocation[index]] ? 2 : 1;
    }
  }
  const canonical = [];
  for (const [index,token] of invocation.entries()) {
    if (optionPositions.has(index) && token === "-F") canonical.push("--filter");
    else if (optionPositions.has(index) && token.startsWith("--filter=")) canonical.push("--filter",token.slice(9));
    else canonical.push(token);
  }
  const identity = tokens.length === 2 ? [tokens[0],canonical] : [canonical];
  return "verification.v2:" + crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function confirmedVerificationResult(response, failureEvent = false, explicitSuccessAttested = false) {
  if (failureEvent) return false;
  if (!response || typeof response !== "object") return null;
  if (response.error || response.is_error === true || response.interrupted === true || response.signal) return false;
  if ("exit_code" in response) return typeof response.exit_code === "number" && Number.isInteger(response.exit_code) ? response.exit_code === 0 : null;
  return explicitSuccessAttested && response.is_error === false ? true : null;
}

const MAX_CONTEXT_CHARS = 1500;
// How many skill NAMES may be offered per session. Names only — see the skill policy in
// buildNavigationBodyBlock. Small on purpose: the value is "you have a procedure for
// this", and a long menu of procedures is itself a distraction.
const SKILL_HINT_LIMIT = 4;
// Graduated body delivery. A memory earns its BODY only if its relevance is within this
// fraction of the best-scoring memory for this prompt; the rest are offered by NAME.
//
// Relative rather than absolute on purpose: the normalised lexical score lives around
// 0.06-0.31 and the cloud cosine around 0.45-0.95, so no single constant means the same
// thing on both paths. What IS comparable across paths is the shape of the distribution,
// and a measured one looked like [0.288, 0.267, 0.182, 0.114, 0.111, 0.106, 0.067,
// 0.059] — a clear head and a long flat tail. At 0.5 the head keeps its bodies and the
// tail becomes a list of names the agent can pull from.
const BODY_RELATIVE_BAR = (() => {
  const raw = Number.parseFloat(process.env.PATHRULE_BODY_RELATIVE_BAR ?? "");
  // Overridable so it can be SWEPT, like the floor and the budget next to it. A bare
  // literal is a knob nobody can measure, and all three of them were bare.
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
})();
// A hard ceiling on how many BODIES one prompt may carry, independent of the bar.
//
// The relative bar alone cannot bound this: when a prompt's scores come out flat — and
// measured distributions do, e.g. seven of eight candidates within half the top score —
// the bar admits nearly everything and the block fills to the char ceiling exactly as
// before. Graduated delivery then changes the mix without changing the cost.
//
// So relevance decides WHICH bodies, and this decides HOW MANY. Everything past it is
// still offered by name, so a low number withholds nothing: it moves the tail from
// "1.400 chars each, whether or not you needed it" to "60 chars each, fetch what you do".
const BODY_COUNT_MAX = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_BODY_COUNT_MAX ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

// The same discipline for RULES.
//
// Rules used to bypass relevance entirely: chosen by path and priority, delivered whole,
// unconditionally. Measured 2026-08-23 on the first prompt of a session, asking about
// `supabase migration grants`: 10.476 chars went out, 100% of it rule bodies, 0 memories,
// and among them "No em dashes anywhere in the project" and "Keep pull requests small and
// single-purpose". Three memories had ranked and all three were dropped for want of space.
//
// A rule is a standing constraint, so it must never become INVISIBLE — but "visible" and
// "1.500 chars of body" are not the same claim. Above the bar it ships whole; below it, the
// name and the id are enough for the agent to notice the constraint exists and read it if
// the work turns out to touch it. Priority cannot do this job: 50 of this workspace's 61
// rules are `high`, so it separates nothing.
//
// Default 1, chosen by sweep rather than taste. Measured over 9 prompts against a
// ground-truth ranking, varying only this cap:
//
//   cap  token   mem top-3  mem reachable  rule top-1 body  rule reachable
//    1   24.285      14           62             2               14
//    2   26.101      13           59             2               14
//    3   26.473      13           48             2               14
//    5   26.513      12           43             2               14
//   12   26.513      12           43             2               14
//
// One body wins on every axis at once: 8,4% fewer tokens than the uncapped behaviour, MORE
// of the top-3 memories delivered whole, and reachability up from 43 to 62 — while the rule
// metrics do not move at all, because the cap changes the FORM of the rules below the top
// one and not whether they are visible. Freeing that space is what lets a prompt-relevant
// memory body ship on the first prompt of a session, which never happened before.
const RULE_BODY_COUNT_MAX = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_RULE_BODY_COUNT_MAX ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();
// Ceiling for full-body delta delivery (~3000 tokens), used only when the
// warehouse supplied a full memory body to inject.
//
// Overridable so it can be SWEPT. It was a bare literal, which is how the floor next
// to it went a whole tuning round unmeasured: the sweep set an env var, the constant
// ignored it, and two different settings came back byte-identical while looking fine.
// Bodies one prompt carries. Every injected char is re-read on every later model call
// of the session; at 12.000 the budget filled with loosely matched documentation (fastapi, 2026-10-15:
// ~30k chars a 10-turn session). The first body always ships; the rest are offered by name.
const PROMPT_BODY_BUDGET_CHARS = (() => { const raw = Number.parseInt(process.env.PATHRULE_PROMPT_BODY_BUDGET_CHARS ?? "", 10); return Number.isFinite(raw) && raw >= 500 ? raw : 1500; })();
const DELTA_MAX_CONTEXT_CHARS = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_BODY_BUDGET_CHARS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 60000) : 12000;
})();
const CURSOR_TO_CLAUDE_EVENT_MAP = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  stop: "Stop",
  subagentStop: "SubagentStop",
};
const CURSOR_TO_CLAUDE_TOOL_MAP = {
  Write: "Edit",
  Shell: "Bash",
};
// Copilot (https://docs.github.com/en/copilot/reference/hooks-configuration)
// sends one of three payload dialects: CLI camelCase ({sessionId, toolName,
// toolArgs}), CLI PascalCase (Claude-shape snake_case fields), or VS Code
// agent mode ({hookEventName: "PreToolUse", sessionId, tool_name,
// tool_input}). Our generated .github/hooks/pathrule.json stamps
// PATHRULE_HOOK_CLIENT=copilot (+ PATHRULE_HOOK_EVENT per entry, since the
// CLI camelCase payload carries no event name); payload-shape checks are the
// fallback for hosts that strip hook env.
const COPILOT_TO_CLAUDE_EVENT_MAP = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  userPromptSubmitted: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUse",
  PostToolUseFailure: "PostToolUse",
  agentStop: "Stop",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
};
const COPILOT_TO_CLAUDE_TOOL_MAP = {
  // Copilot CLI + cloud coding agent tool names. Keep in lockstep with
  // the Copilot tool map (canonical lowercase variant).
  view: "Read",
  edit: "Edit",
  create: "Write",
  bash: "Bash",
  powershell: "Bash",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  // VS Code agent mode names (docs show both naming generations; unknown
  // names flow through unmapped and no-op harmlessly).
  read_file: "Read",
  readFile: "Read",
  editFiles: "Edit",
  replace_string_in_file: "Edit",
  createFile: "Write",
  create_file: "Write",
  runTerminalCommand: "Bash",
  run_in_terminal: "Bash",
};
// Codex (https://developers.openai.com/codex/hooks) sends Claude-shape events
// with PascalCase names; only the tool surface diverges (`apply_patch`
// replaces Edit/Write, no Read tool). The patch body lives in
// tool_input.command and embeds the target path via `*** Update File:` etc.
const CODEX_PATCH_FILE_RE = /\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*([^\n]+)/;
// Keep the session state compact — prevents unbounded growth on day-long sessions.
const MAX_TRACKED_RULE_IDS = 150;
const MAX_TRACKED_MEMORY_IDS = 150;
const MAX_TRACKED_PROMPT_RULE_IDS = 80;
const DEFAULT_REINJECT_AFTER_TOOL_CALLS = 50;
const DEFAULT_REINJECT_AFTER_MINUTES = 60;
const SAFETY_RULE_LIMIT = 2;
// UserPromptSubmit metadata+project_rules refresh cadence. Panel
// stats counted every repeat as an injection, inflating numbers for content
// the agent had already seen. N=12 keeps long sessions honest without letting
// the agent forget workspace_id in a mega-session.
const USER_PROMPT_REFRESH_EVERY = 12;
const PROMPT_PROJECT_RULE_LIMIT = 3;

const REFRESH_MAINTENANCE_RE =
  /\b(refresh|pending refresh|suggestion|suggestions|stale|öneri|oneri|bayat)\b|(?:memory|rule|hafiza|hafıza|kural).{0,24}\b(refresh|güncelle|guncelle|bakım|bakim)\b/i;

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const REINJECT_AFTER_TOOL_CALLS = readPositiveIntEnv(
  "PATHRULE_REINJECT_AFTER_TOOL_CALLS",
  DEFAULT_REINJECT_AFTER_TOOL_CALLS,
);
const REINJECT_AFTER_MINUTES = readPositiveIntEnv(
  "PATHRULE_REINJECT_AFTER_MINUTES",
  DEFAULT_REINJECT_AFTER_MINUTES,
);

const startedAt = Date.now();

// ─── Shared helpers ──────────────────────────────────────────────────────────

function emitEmpty() {
  process.stdout.write("{}\n");
  process.exit(0);
}

// ─── Empty payload defense ──────────────────────────────────────────────
// Phase 4: suppress empty hook payloads and track them with a counter.
// This prevents 47+ no-op round-trips per 34 days that emit {} with no value.
let hookEmptySkippedCount = 0;
let hookEmptyNoWorkspaceCount = 0;
let hookEmptyAllFilteredCount = 0;

function emitEmptyDefended(causeHint) {
  // Increment the appropriate counter before emitting {}.
  hookEmptySkippedCount++;
  if (causeHint === "no_workspace") {
    hookEmptyNoWorkspaceCount++;
  } else {
    hookEmptyAllFilteredCount++;
  }
  // Still emit {} so the client never sees a missing payload.
  process.stdout.write("{}\n");
  process.exit(0);
}

// ─── Rule injection strategy filter ─────────────────────────────────────
// In-process session memo for session_once strategy.
// 30-minute idle TTL. Process restart clears all state.
const M44_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const m44SessionMemo = new Map(); // Map<sessionId, { rules: Set<ruleId>, lastTouchMs: number }>

function m44EvictIdleSessions(nowMs) {
  for (const [sid, memo] of m44SessionMemo) {
    if (nowMs - memo.lastTouchMs > M44_SESSION_IDLE_TTL_MS) {
      m44SessionMemo.delete(sid);
    }
  }
}

/**
 * Filter candidate rules by injection_strategy.
 * Returns { injected: RuleStub[], breakdown: { per_call, session_once, session_once_skipped, claude_md_only_skipped } }
 *
 * @param {string} sid - session_id
 * @param {Array} candidates - array of rule stubs with injection_strategy field
 * @param {boolean} promotionEnabled - feature flag; if false all rules are per_call
 */
function m44SelectInjectedRules(sid, candidates, promotionEnabled) {
  const breakdown = {
    per_call: 0,
    session_once: 0,
    session_once_skipped: 0,
    claude_md_only_skipped: 0,
  };

  if (!promotionEnabled) {
    return {
      injected: candidates,
      breakdown: Object.assign(breakdown, { per_call: candidates.length }),
    };
  }

  const nowMs = Date.now();
  m44EvictIdleSessions(nowMs);

  let memo = m44SessionMemo.get(sid);
  if (!memo) {
    memo = { rules: new Set(), lastTouchMs: nowMs };
    m44SessionMemo.set(sid, memo);
  }
  memo.lastTouchMs = nowMs;

  const injected = [];
  for (const rule of candidates) {
    const strategy = rule.injection_strategy || "per_call";
    switch (strategy) {
      case "per_call":
        injected.push(rule);
        breakdown.per_call++;
        break;
      case "session_once":
        if (memo.rules.has(rule.id)) {
          breakdown.session_once_skipped++;
        } else {
          memo.rules.add(rule.id);
          injected.push(rule);
          breakdown.session_once++;
        }
        break;
      case "claude_md_only":
        breakdown.claude_md_only_skipped++;
        break;
      default:
        // Unknown strategy — treat as per_call (safe default).
        injected.push(rule);
        breakdown.per_call++;
    }
  }

  return { injected, breakdown };
}

// ─── Extensions ──────────────────────────────────────────────────────────────
//
// Capability this script does not carry comes from extension modules an installer writes
// next to it (contract: @pathrule/protocol/hook-extension.ts, pinned to these constants by
// a test). Each is loaded the first time something asks for it, so an event that needs
// neither pays for neither. A missing file is the open edition, not an error; a file that
// fails to load or speaks another contract version is logged and treated as missing.
const HOOK_EXTENSION_CONTRACT = 1;
const HOOK_EXTENSION_FILES = { cloud: "pathrule-hook-cloud.cjs" };
const loadedExtensions = new Map();

function hookExtension(kind) {
  if (loadedExtensions.has(kind)) return loadedExtensions.get(kind);
  let extension = null;
  const file = path.join(__dirname, HOOK_EXTENSION_FILES[kind]);
  if (fs.existsSync(file)) {
    try {
      const mod = require(file);
      if (mod && mod.contract === HOOK_EXTENSION_CONTRACT && typeof mod.create === "function") {
        extension = mod.create(extensionHost());
      } else {
        logLatency("extension", kind, `contract_mismatch:${mod ? mod.contract : "none"}`);
      }
    } catch {
      logLatency("extension", kind, "load_error");
    }
  }
  loadedExtensions.set(kind, extension);
  return extension;
}

// Only ever called from an event handler, after the event is normalised and the workspace
// index resolved.
function extensionHost() {
  return {
    pathruleHome: PATHRULE_HOME,
    cacheDir: CACHE_DIR,
    binDir: __dirname,
    supervisorConfig: SUPERVISOR_CONFIG,
    bodyBudgetChars: DELTA_MAX_CONTEXT_CHARS,
    event,
    eventName,
    toolName,
    cwd,
    sessionId,
    sessionFile,
    clientShape,
    index,
    workspaceId,
    logLatency,
    emit,
    emitEmpty,
    readSessionState,
    writeSessionState,
    normalizePath: m43NormalizePath,
    toRelative,
  };
}

// The delivery decisions: the prompt's budget, the affinity boosts, the order and the evidence.
const deliveryDecisions = {
  readContextPressure: () => false,
  promptBudget: () => PROMPT_BODY_BUDGET_CHARS,
  applyKnowledgePulls: () => 0,
  serverAffinityBoost: () => 1,
  learnedAffinityBoost: () => 1,
  provenMemoryIds: () => new Set(),
  orderBodyItems: ({ ruleItems, memItems }) => [...ruleItems, ...memItems],
  notePromptIntent: () => undefined,
  recordDelivery: () => undefined,
  recordInjection: () => undefined,
};

// The proposed order for the items it placed, then whatever it left out in the Foundation's order.
// A strict rule leads regardless.
function reconcileBodyOrder(proposed, foundationOrder, strictIds) {
  const byId = new Map(foundationOrder.map((it) => [it.id, it]));
  const placed = proposed.map((it) => byId.get(it && it.id)).filter(Boolean);
  return [...new Set([...placed, ...foundationOrder])].sort((a, b) => strictIds.has(b.id) - strictIds.has(a.id));
}

// The cloud extension: hosted ranking, teammates' work state, and telemetry.
function cloudExtension() {
  return hookExtension("cloud");
}

// A Pathrule Local workspace: its store is in this home and is not a cloud workspace's mirror. The
// cloud extension's hosted ranking and teammate checks reach the account (the teammate check tells
// the team's work state which files are being written), so a Local workspace never reaches them,
// whatever is installed beside the hook: Local stays on this machine.
function isLocalWorkspace(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) return false;
  const store = path.join(PATHRULE_HOME, id);
  return fs.existsSync(path.join(store, "pathrule.db")) && !fs.existsSync(path.join(store, ".mirror"));
}

// One emitted injection or decision, for the extensions that record it. An event with nothing
// to record loads nothing.
function recordInjection(record) {
  if (!record.workspaceId) return;
  const skillIds = Array.isArray(record.skillIds) ? record.skillIds : [];
  const hasCounts = record.ruleCount > 0 || record.memoryCount > 0 || skillIds.length > 0;
  const hasDecision = typeof record.decision === "string" && record.decision.length > 0;
  if (!hasCounts && !hasDecision) return;
  cloudExtension()?.logInjection(record);
  deliveryDecisions.recordInjection(record);
}

let clientShape = "claude";
let verificationAdapterSuccessAttested = false;
// Copilot output formatting differs per host: "vscode" expects the Claude-
// style hookSpecificOutput envelope, "cli" expects top-level fields.
let copilotDialect = null;
let canonicalEventName = null;

// Cursor's hook output schema is event-specific (https://cursor.com/docs/agent/hooks).
// Only PostToolUse and SessionStart accept additional_context. PreToolUse can
// only block (permission) or rewrite tool input (updated_input). Emitting a
// Claude-shape additionalContext on PreToolUse just gets silently dropped.
const CURSOR_EVENTS_ACCEPTING_CONTEXT = new Set(["PostToolUse", "SessionStart"]);
const CURSOR_EVENTS_ACCEPTING_PERMISSION = new Set(["PreToolUse"]);

// Copilot context acceptance is per-surface: the CLI takes top-level
// additionalContext on these events (10 KB total cap — far above our
// MAX_CONTEXT_CHARS), VS Code additionally accepts it on PreToolUse.
const COPILOT_CLI_EVENTS_ACCEPTING_CONTEXT = new Set([
  "SessionStart",
  "PostToolUse",
  "SubagentStart",
  "Notification",
]);
const COPILOT_VSCODE_EVENTS_ACCEPTING_CONTEXT = new Set([
  "SessionStart",
  "SubagentStart",
  "PreToolUse",
  "PostToolUse",
]);

function denormalizeOutput(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (clientShape === "cursor") return denormalizeCursorOutput(obj);
  if (clientShape === "copilot") return denormalizeCopilotOutput(obj);
  return obj;
}

function denormalizeCursorOutput(obj) {
  const out = { ...obj };
  const acceptsContext = CURSOR_EVENTS_ACCEPTING_CONTEXT.has(canonicalEventName);
  const acceptsPermission = CURSOR_EVENTS_ACCEPTING_PERMISSION.has(canonicalEventName);

  if (out.decision === "deny" || out.decision === "ask") {
    if (acceptsPermission) {
      out.permission = out.decision;
      if (typeof out.reason === "string") out.agent_message = out.reason;
    }
    delete out.decision;
    delete out.reason;
  }

  if (out.hookSpecificOutput && typeof out.hookSpecificOutput === "object") {
    const additionalContext = out.hookSpecificOutput.additionalContext;
    if (acceptsContext && typeof additionalContext === "string" && additionalContext.length > 0) {
      out.additional_context = additionalContext;
    }
    const updatedInput = out.hookSpecificOutput.updatedInput;
    if (acceptsPermission && updatedInput && typeof updatedInput === "object") {
      out.updated_input = updatedInput;
    }
    delete out.hookSpecificOutput;
  }
  // Strip Claude-only top-level fields Cursor would otherwise warn on.
  delete out.continue;
  delete out.suppressOutput;
  delete out.systemMessage;
  return out;
}

function denormalizeCopilotOutput(obj) {
  const additionalContext =
    obj.hookSpecificOutput && typeof obj.hookSpecificOutput.additionalContext === "string"
      ? obj.hookSpecificOutput.additionalContext
      : null;
  const isPermission =
    (obj.decision === "deny" || obj.decision === "ask") && canonicalEventName === "PreToolUse";
  const permissionReason =
    typeof obj.reason === "string" ? obj.reason : "Blocked by a Pathrule strict rule.";

  if (copilotDialect === "vscode") {
    const hookSpecificOutput = { hookEventName: canonicalEventName };
    let hasPayload = false;
    if (additionalContext && COPILOT_VSCODE_EVENTS_ACCEPTING_CONTEXT.has(canonicalEventName)) {
      hookSpecificOutput.additionalContext = additionalContext;
      hasPayload = true;
    }
    if (isPermission) {
      hookSpecificOutput.permissionDecision = obj.decision;
      hookSpecificOutput.permissionDecisionReason = permissionReason;
      hasPayload = true;
    }
    return hasPayload ? { hookSpecificOutput } : {};
  }

  // CLI dialect (also the cloud coding agent) — top-level fields only.
  const out = {};
  if (isPermission) {
    out.permissionDecision = obj.decision;
    out.permissionDecisionReason = permissionReason;
  }
  if (additionalContext && COPILOT_CLI_EVENTS_ACCEPTING_CONTEXT.has(canonicalEventName)) {
    out.additionalContext = additionalContext;
  }
  return out;
}

// Work that may run only once the output has actually been written: the delivery receipts.
// Each task gets `true` when the write succeeded. Selection is not delivery, so nothing is
// recorded as delivered before this point.
const afterEmitTasks = [];
function afterEmit(task) {
  afterEmitTasks.push(task);
}

function emit(obj) {
  let payload;
  try {
    payload = JSON.stringify(denormalizeOutput(obj)) + "\n";
  } catch {
    // Unserializable output is Pathrule's bug, not the client's.
    process.exit(0);
  }
  // Synchronous on purpose: callers rely on emit() never returning, and the receipts below must
  // know the whole payload reached the pipe. A short non-blocking pipe is retried, bounded.
  let ok = false;
  try {
    const buffer = Buffer.from(payload, "utf8");
    let offset = 0;
    let spins = 0;
    while (offset < buffer.length) {
      try {
        offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
      } catch (err) {
        if (err && err.code === "EAGAIN" && spins < 2000) {
          spins += 1;
          continue;
        }
        throw err;
      }
    }
    ok = true;
  } catch {
    ok = false;
  }
  for (const task of afterEmitTasks) {
    try {
      task(ok);
    } catch {
      // a receipt that cannot be written costs at most one repeated delivery
    }
  }
  process.exit(0);
}

function logLatency(event, toolName, decision) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(LOG_DIR, `hooks-${today}.log`);
    const line = [
      new Date().toISOString(),
      event ?? "-",
      toolName ?? "-",
      `${Date.now() - startedAt}ms`,
      decision ?? "-",
    ].join("\t");
    fs.appendFileSync(logPath, line + "\n");
  } catch {
    // Never break the hook on telemetry errors.
  }
}

// ─── Kill switch ─────────────────────────────────────────────────────────────
if (fs.existsSync(KILL_SWITCH)) {
  logLatency("kill_switch", null, "skip");
  emitEmpty();
}

// ─── Stdin JSON ──────────────────────────────────────────────────────────────
let rawInput = "";
try {
  rawInput = fs.readFileSync(0, "utf8");
} catch {
  emitEmpty();
}

let event = null;
try {
  event = JSON.parse(rawInput);
} catch {
  logLatency("parse_error", null, "skip");
  emitEmpty();
}

if (!event || typeof event !== "object") emitEmpty();

// Copilot detection MUST precede the codex check: Copilot's sessionStart also
// carries source:"startup"|"resume". The env stamp comes from our generated
// hook config; the payload-shape checks (camelCase keys no other client uses)
// are the fallback for hosts that strip hook env.
if (typeof event.cursor_version === "string" || typeof event.conversation_id === "string") {
  clientShape = "cursor";
} else if (
  process.env.PATHRULE_HOOK_CLIENT === "copilot" ||
  typeof event.hookEventName === "string" ||
  typeof event.toolName === "string" ||
  typeof event.sessionId === "string"
) {
  clientShape = "copilot";
} else if (
  event.tool_name === "apply_patch" ||
  // Codex stamps every event with the active `model`; Claude Code's session start carries the same
  // `source` values and no `model`, so `source` alone read a Claude Code session start as Codex's.
  ((event.source === "startup" || event.source === "resume" || event.source === "clear") &&
    typeof event.model === "string") ||
  (typeof event.turn_id === "string" && typeof event.model === "string")
) {
  clientShape = "codex";
} else {
  clientShape = "claude";
}

if (clientShape === "cursor") {
  const hookEventName = CURSOR_TO_CLAUDE_EVENT_MAP[event.hook_event_name] ?? event.hook_event_name;
  const toolName = CURSOR_TO_CLAUDE_TOOL_MAP[event.tool_name] ?? event.tool_name;
  const toolInput =
    event.tool_input && typeof event.tool_input === "object"
      ? {
          ...event.tool_input,
          new_string:
            event.tool_input.new_string ??
            event.tool_input.content ??
            event.tool_input.newText ??
            null,
        }
      : event.tool_input;
  event = {
    ...event,
    hook_event_name: hookEventName,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: event.session_id ?? event.conversation_id ?? null,
  };
} else if (clientShape === "copilot") {
  // Normalize whichever Copilot dialect arrived into Claude canonical form.
  // VS Code sends {hookEventName, sessionId, tool_name, tool_input}; the CLI
  // sends camelCase ({toolName, toolArgs}) or Claude-shape PascalCase. The
  // CLI camelCase payload carries no event name at all — our config stamps
  // PATHRULE_HOOK_EVENT per entry as the last resort.
  copilotDialect = typeof event.hookEventName === "string" ? "vscode" : "cli";
  const rawEventName =
    (typeof event.hookEventName === "string" && event.hookEventName) ||
    (typeof event.hook_event_name === "string" && event.hook_event_name) ||
    process.env.PATHRULE_HOOK_EVENT ||
    "";
  const rawToolName =
    typeof event.tool_name === "string"
      ? event.tool_name
      : typeof event.toolName === "string"
        ? event.toolName
        : null;
  const rawInput =
    (event.tool_input && typeof event.tool_input === "object" ? event.tool_input : null) ??
    (event.toolArgs && typeof event.toolArgs === "object" ? event.toolArgs : null);
  const toolInput = rawInput
    ? {
        ...rawInput,
        file_path: rawInput.file_path ?? rawInput.filePath ?? rawInput.path ?? null,
        new_string:
          rawInput.new_string ?? rawInput.newString ?? rawInput.content ?? rawInput.newText ?? null,
      }
    : event.tool_input;
  // Synthesize Claude's tool_response from whichever result field arrived so
  // handlePostToolUse's error detection + outcome capture work unchanged.
  // postToolUseFailure carries `error` instead of a result object.
  let toolResponse = event.tool_response;
  const camelResult = event.toolResult && typeof event.toolResult === "object" ? event.toolResult : null;
  const snakeResult = event.tool_result && typeof event.tool_result === "object" ? event.tool_result : null;
  if (toolResponse == null && (camelResult || snakeResult)) {
    const resultType = camelResult ? camelResult.resultType : snakeResult.result_type;
    verificationAdapterSuccessAttested = resultType === "success";
    toolResponse = {
      content: (camelResult ? camelResult.textResultForLlm : snakeResult.text_result_for_llm) ?? null,
      is_error: typeof resultType === "string" && resultType !== "success",
    };
  }
  if (toolResponse == null && event.error != null) {
    const message =
      typeof event.error === "string"
        ? event.error
        : (event.error && typeof event.error.message === "string" && event.error.message) ||
          "tool failed";
    toolResponse = { is_error: true, error: message };
  }
  event = {
    ...event,
    hook_event_name: COPILOT_TO_CLAUDE_EVENT_MAP[rawEventName] ?? rawEventName,
    tool_name: rawToolName ? (COPILOT_TO_CLAUDE_TOOL_MAP[rawToolName] ?? rawToolName) : rawToolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    session_id: event.session_id ?? event.sessionId ?? null,
  };
} else if (clientShape === "codex" && event.tool_name === "apply_patch") {
  // Codex's apply_patch lifts add/update/delete edits into a single tool with
  // the patch body in tool_input.command. Map to canonical Edit so the rest
  // of the dispatch (handlePreToolUse path-scoped + BLOCK_PATTERN check)
  // works without a Codex-specific branch. Output schema is Claude-shape, so
  // no denormalize change is needed.
  const command = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
  const fileMatch = command.match(CODEX_PATCH_FILE_RE);
  const rawFilePath = fileMatch ? fileMatch[1].trim() : null;
  const rawCwd =
    event.cwd ??
    (Array.isArray(event.workspace_roots) ? event.workspace_roots[0] : null) ??
    process.cwd();
  const filePath =
    rawFilePath && path.isAbsolute(rawFilePath)
      ? rawFilePath
      : rawFilePath
        ? path.join(rawCwd, rawFilePath)
        : null;
  event = {
    ...event,
    tool_name: "Edit",
    tool_input: {
      ...(event.tool_input ?? {}),
      file_path: filePath,
      new_string: command,
    },
  };
}

const eventName = event.hook_event_name;
canonicalEventName = eventName;
const toolName = event.tool_name ?? null;
const cwd =
  event.cwd ??
  (Array.isArray(event.workspace_roots) ? event.workspace_roots[0] : null) ??
  process.cwd();
const sessionId = typeof event.session_id === "string" ? event.session_id : null;

// SessionStart's `source` is the context-lifecycle signal, and it is not
// client-specific: Claude Code documents startup | resume | clear | compact |
// fork, and Codex and Copilot carry the same startup/resume values.
//
// This was gated on `clientShape === "codex"`, which opened for Claude Code only
// by accident — `source: "startup"` is itself one of the codex-detection signals
// below, so a Claude Code SessionStart was misread as Codex and the gate happened
// to pass. `compact` and `fork` are not in that list, so they fell through to
// clientShape "claude" and the gate closed on exactly the two events that destroy
// the delivered context. Measured 2026-09-01: after `source: "compact"` the hook
// kept every injected_* id from a context that had just been summarised away and
// went silent for the rest of the session.
//
// `compact` is the one that matters. Almost nobody types /compact — Claude Code
// auto-compacts long sessions on its own, which is precisely the regime this hook
// exists for. `resume` and `fork` keep the transcript, and SessionStart's context is
// IN it (measured 2026-10-15: three resumed turns held four protocol copies), so they keep state.
function isExplicitContextResetEvent() {
  return eventName === "SessionStart" && (event.source === "clear" || event.source === "compact");
}

if (event.stop_hook_active === true) {
  logLatency(eventName, toolName, "loop_guard");
  emitEmpty();
}

// ─── Native integrations: one event, one run ─────────────────────────────────
//
// The same hook can be registered twice for one agent: a native plugin's copy beside a legacy
// settings entry (Claude Code runs both), or a provider that also imports another provider's hook
// config. Every registration receives the identical event on stdin, so the first process to claim
// that exact event handles it and the others answer `{}`. Only events that inject or record are
// claimed; a claim older than the window is a new event that happens to look the same.

// A session id names files, and the provider's payload is not trusted to be file-safe.
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
function sessionStemOf(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  return SAFE_SESSION_ID.test(id) && id !== "." && id !== ".."
    ? id
    : `h-${crypto.createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32)}`;
}
const sessionStem = sessionStemOf(sessionId);

const CLAIMED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const CLAIM_WINDOW_MS = 3000;
const CLAIM_DIR = path.join(CACHE_DIR, "hook-claims");

// Which registration this process is: a plugin's launcher says so; anything else is a settings entry.
const HOOK_CHANNEL = process.env.PATHRULE_HOOK_CHANNEL === "plugin" ? "plugin" : "settings";

/**
 * Claim this event for this registration. A provider runs one registration once per event, so a
 * claim by the SAME channel is a new event that looks the same (the same prompt twice): it runs.
 * Only another registration's fresh claim (or one still being written) makes this run a duplicate.
 */
function claimThisEvent() {
  if (!CLAIMED_EVENTS.has(eventName) || !rawInput) return true;
  const key = crypto.createHash("sha1").update(`${clientShape}\0${rawInput}`, "utf8").digest("hex");
  const file = path.join(CLAIM_DIR, `${sessionStem ?? "nosession"}-${key}`);
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true, mode: 0o700 });
  } catch {
    return true;
  }
  const take = () => {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, HOOK_CHANNEL);
    } finally {
      fs.closeSync(fd);
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      take();
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") return true; // cannot claim: run rather than go silent
      try {
        const owner = fs.readFileSync(file, "utf8");
        const fresh = Date.now() - fs.statSync(file).mtimeMs < CLAIM_WINDOW_MS;
        if (fresh && owner !== HOOK_CHANNEL) return false;
        fs.unlinkSync(file);
      } catch {
        return true;
      }
    }
  }
  return true;
}

// Old claims go at the next session start; a session's own go at its end.
function pruneEventClaims(prefix) {
  try {
    const now = Date.now();
    let removed = 0;
    for (const name of fs.readdirSync(CLAIM_DIR)) {
      if (removed >= 500) break;
      const file = path.join(CLAIM_DIR, name);
      if (prefix ? name.startsWith(`${prefix}-`) : now - fs.statSync(file).mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(file);
        removed += 1;
      }
    }
  } catch {
    // nothing to prune
  }
}

if (!claimThisEvent()) {
  logLatency(eventName, toolName, "duplicate_registration");
  emitEmpty();
}

// ─── Native integrations: the provider's context limit ───────────────────────
//
// A provider saves hook output past its limit to a file and shows the model only a preview, so an
// item cut there was never delivered. Claude Code caps additionalContext at 10,000 characters;
// Codex at roughly 2,500 tokens per message, budgeted here as 7,000 characters. Other clients keep
// the hook's own caps. PATHRULE_PROVIDER_CONTEXT_LIMIT overrides (tests, a provider change).
// The provider this event came from. A plugin launcher names it; otherwise the payload's shape
// decides (which reads a Claude Code session start as Codex's, the more conservative limit).
const sessionProvider =
  process.env.PATHRULE_HOOK_PROVIDER === "claude-code" || process.env.PATHRULE_HOOK_PROVIDER === "codex"
    ? process.env.PATHRULE_HOOK_PROVIDER
    : clientShape === "claude"
      ? "claude-code"
      : clientShape === "codex"
        ? "codex"
        : null;
const PROVIDER_CONTEXT_LIMITS = { "claude-code": 10000, codex: 7000 };
const PROVIDER_CONTEXT_LIMIT = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_PROVIDER_CONTEXT_LIMIT ?? "", 10);
  if (Number.isFinite(raw) && raw >= 1000) return raw;
  return (sessionProvider && PROVIDER_CONTEXT_LIMITS[sessionProvider]) ?? null;
})();
// Room kept for the lines around the bodies (metadata, rule names, advisories) on a prompt.
const PROVIDER_FRAME_RESERVE = 2000;
// The body budget the provider leaves for this prompt, and the bodies the last body block carried,
// so the final cut can tell which of them actually went out.
let promptBodyCap = Infinity;
let lastBodyDelivered = [];

// How far back a cut may reach for a line break before it settles for a word boundary instead: a
// body written as one long line must lose its tail, not the whole of itself.
const LINE_CUT_SLACK = 400;

/** Where to end `head`: its last line break when one is near the end, else its last word boundary. */
function cutPoint(head) {
  const lastBreak = head.lastIndexOf("\n");
  if (lastBreak > 0 && head.length - lastBreak <= LINE_CUT_SLACK) return lastBreak;
  const lastSpace = head.search(/\s\S*$/);
  return lastSpace > 0 ? lastSpace : head.length;
}

const PROVIDER_CUT_MARKER =
  "[Pathrule: the rest of this context did not fit the agent's hook output limit and was not sent. Items not shown above stay available by id.]";

/**
 * Fit `body` after `framing` into the provider's limit, cutting `body` at a line or word boundary and
 * saying so. Framing (the protocol, the profiles) is never cut. Returns the kept body.
 */
function fitProviderLimit(body, framingLength) {
  if (!PROVIDER_CONTEXT_LIMIT || typeof body !== "string") return { text: body, cut: false };
  const room = PROVIDER_CONTEXT_LIMIT - framingLength;
  if (body.length <= room) return { text: body, cut: false };
  const budget = room - PROVIDER_CUT_MARKER.length - 2;
  if (budget <= 0) return { text: "", cut: true };
  const head = body.slice(0, budget);
  const section = head.lastIndexOf("\n### "); // a body never ships cut in half: the cut falls before the last section header past the midpoint
  const kept = head.slice(0, section > budget / 2 ? section : cutPoint(head)).trimEnd();
  return { text: kept.length > 0 ? `${kept}\n${PROVIDER_CUT_MARKER}` : PROVIDER_CUT_MARKER, cut: true };
}

// ─── Native integrations: MCP availability for the protocol's framing ────────
//
// A session with no Pathrule MCP server must never be told to call a `pathrule_*` tool. The plugin
// launcher says what its integration ships; otherwise the integration registry decides; with
// neither (a legacy install), MCP is assumed, which is what the hook always did.
function mcpAvailableForSession() {
  if (process.env.PATHRULE_HOOK_MCP === "none") return false;
  if (process.env.PATHRULE_HOOK_MCP === "bundled") return true;
  const provider = sessionProvider;
  if (!provider) return true;
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(PATHRULE_HOME, "integrations", "registry.json"), "utf8"));
    let best = null;
    for (const r of Array.isArray(registry.integrations) ? registry.integrations : []) {
      if (!r || r.provider !== provider) continue;
      if (r.scope === "project" && typeof r.project_root === "string") {
        if (pathsEqual(cwd, r.project_root) || pathStartsWith(cwd, r.project_root)) {
          if (!best || best.scope !== "project" || best.project_root.length < r.project_root.length) best = r;
        }
      } else if (r.scope === "user" && !best) {
        best = r;
      }
    }
    return best ? best.mcp !== false : true;
  } catch {
    return true;
  }
}

// ─── Native integrations: the session delivery ledger ────────────────────────
//
// One append-only file per session (protocol/session-delivery.ts), shared with the MCP server:
// `cache/<workspace>/deliveries/<session>.jsonl`. The hook appends a receipt only after its output
// was written, reads what the MCP server delivered so a body it already gave is not repeated, and
// starts a new epoch when the agent's context was reset. This is the plain-JS twin of
// `foldDeliveryLedger`; session-delivery-contract.test.ts pins the two together.
const DELIVERY_MAX_READ_BYTES = 512 * 1024;
let deliveryLedgerCache = null;

function deliveryLedgerFile(wsId) {
  return sessionStem && wsId ? path.join(CACHE_DIR, wsId, "deliveries", `${sessionStem}.jsonl`) : null;
}

function readDeliveryLedger(wsId) {
  if (deliveryLedgerCache) return deliveryLedgerCache;
  const state = { epoch: 0, delivered: new Map() };
  deliveryLedgerCache = state;
  const file = deliveryLedgerFile(wsId);
  if (!file) return state;
  let text = "";
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - DELIVERY_MAX_READ_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return state;
  }
  const records = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || r.v !== 1 || typeof r.epoch !== "number") continue;
    if (r.type === "epoch") {
      state.epoch = Math.max(state.epoch, r.epoch);
      records.push(r);
    } else if (r.type === "receipt" && r.item && typeof r.item.kind === "string" && typeof r.item.id === "string") {
      records.push(r);
    }
  }
  for (const r of records) {
    if (r.type !== "receipt" || r.epoch !== state.epoch) continue;
    const key = `${r.item.kind}:${r.item.id}`;
    const hash = typeof r.item.hash === "string" ? r.item.hash : null;
    if (r.status === "confirmed") {
      state.delivered.set(key, { hash, channel: r.channel, scope: r.item.scope });
    } else if (r.status === "failed") {
      const prior = state.delivered.get(key);
      if (prior && prior.hash === hash) state.delivered.delete(key);
    }
  }
  return state;
}

function appendDeliveryLines(wsId, records) {
  const file = deliveryLedgerFile(wsId);
  if (!file || records.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    // a ledger that cannot be written costs at most one repeated delivery
  }
}

/** Receipts for items this event's output carried, written once the output was written. */
function recordDeliveries(wsId, items) {
  if (!sessionStem || !wsId || items.length === 0) return;
  afterEmit((ok) => {
    const ledger = readDeliveryLedger(wsId);
    const at = new Date().toISOString();
    appendDeliveryLines(
      wsId,
      items.map((item) => ({
        v: 1,
        type: "receipt",
        at,
        workspace_id: wsId,
        session_id: sessionId,
        epoch: ledger.epoch,
        channel: "hook",
        client: clientShape,
        event: eventName,
        item: { kind: item.kind, id: item.id, hash: item.hash ?? null, scope: item.scope ?? "project", node_path: item.node_path ?? null },
        provenance: { source: "hook-index" },
        status: ok ? "confirmed" : "failed",
        ...(ok ? {} : { reason: "write_error" }),
      })),
    );
  });
}

/** Receipts for items selected for this output and then cut by the provider's limit. */
function recordCutDeliveries(wsId, items) {
  if (!sessionStem || !wsId || items.length === 0) return;
  const ledger = readDeliveryLedger(wsId);
  const at = new Date().toISOString();
  appendDeliveryLines(
    wsId,
    items.map((item) => ({
      v: 1,
      type: "receipt",
      at,
      workspace_id: wsId,
      session_id: sessionId,
      epoch: ledger.epoch,
      channel: "hook",
      client: clientShape,
      event: eventName,
      item: { kind: item.kind, id: item.id, hash: item.hash ?? null, scope: item.scope ?? "project", node_path: null },
      provenance: { source: "hook-index" },
      status: "failed",
      reason: "provider_limit",
    })),
  );
}

/** A context reset (compaction, clear, resume, fork): what was delivered before is gone. */
function startDeliveryEpoch(wsId, reason) {
  if (!sessionStem || !wsId) return;
  const ledger = readDeliveryLedger(wsId);
  ledger.epoch += 1;
  ledger.delivered.clear();
  appendDeliveryLines(wsId, [
    { v: 1, type: "epoch", at: new Date().toISOString(), workspace_id: wsId, session_id: sessionId, epoch: ledger.epoch, reason },
  ]);
}

/**
 * Bodies another channel (the MCP server) already delivered in this epoch, merged into the hook's
 * own delta ledger for this run, so the hook stays silent on content the agent already has.
 */
function mergeOtherChannelDeliveries(wsId, state) {
  if (!state || !wsId) return state;
  const ledger = readDeliveryLedger(wsId);
  for (const [key, entry] of ledger.delivered) {
    if (entry.channel === "hook" || !entry.hash) continue;
    const sep = key.indexOf(":");
    const kind = key.slice(0, sep);
    if (kind !== "memory" && kind !== "rule" && kind !== "skill") continue;
    const id = key.slice(sep + 1);
    if (!state.injected_memory_hashes) state.injected_memory_hashes = {};
    if (!state.injected_memory_hashes[id]) state.injected_memory_hashes[id] = entry.hash;
  }
  return state;
}

// ─── Native integrations: hook-triggered maintenance ─────────────────────────
//
// With the person's consent (recorded by setup in the runtime manifest), the hook asks the runtime
// to refresh a stale index at session start and to process captured learning evidence at the end
// of a turn. Both run in a detached runtime process through the host, so this hook never waits,
// downloads or calls a model, and both are rate-limited per workspace.
let runtimeManifestCache;
function runtimeManifest() {
  if (runtimeManifestCache !== undefined) return runtimeManifestCache;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(PATHRULE_HOME, "bin", "runtime.json"), "utf8"));
    runtimeManifestCache =
      m && m.schema_version === 1 && m.cli && typeof m.cli.node === "string" && typeof m.cli.entry === "string" ? m : null;
  } catch {
    runtimeManifestCache = null;
  }
  return runtimeManifestCache;
}

function maintenanceAllowed() {
  if (process.env.PATHRULE_MAINTENANCE === "1") return false; // never recurse from a maintenance run
  const m = runtimeManifest();
  return !!(m && m.maintenance && m.maintenance.consent === true && fs.existsSync(m.cli.entry));
}

function spawnMaintenance(wsId, job, args, minIntervalMs) {
  if (!maintenanceAllowed() || !wsId) return false;
  const stamp = path.join(CACHE_DIR, wsId, `maintenance-${job}.stamp`);
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < minIntervalMs) return false;
  } catch {
    // never ran
  }
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, `${process.pid}\n`);
    const m = runtimeManifest();
    const { spawn } = require("node:child_process");
    const child = spawn(m.cli.node, [m.cli.entry, ...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...(m.cli.env || {}), PATHRULE_MAINTENANCE: "1" },
    });
    child.on("error", () => {});
    child.unref();
    logLatency("maintenance", job, "spawned");
    return true;
  } catch {
    return false;
  }
}

/** The local store changed after the index was written: the hook is reading old knowledge. */
function localIndexIsStale(idx) {
  const generated = genTime(idx);
  if (!generated || indexMode(idx) === "cloud") return false; // a Cloud index never reads a Local store
  for (const name of ["pathrule.db", "pathrule.db-wal"]) {
    try {
      if (fs.statSync(path.join(PATHRULE_HOME, idx.workspace_id, name)).mtimeMs > generated + 1000) return true;
    } catch {
      // absent: a cloud workspace, or no write since
    }
  }
  return false;
}

function maybeRefreshIndex(idx) {
  if (!idx || !idx.workspace_id || !localIndexIsStale(idx)) return;
  spawnMaintenance(idx.workspace_id, "index", ["index", "refresh", "--workspace", idx.workspace_id, "--quiet"], 60 * 1000);
}

function maybeDrainLearning(idx) {
  if (!idx || !idx.workspace_id) return;
  // The turn's transcript, for lessons its own commands taught (core maintenance/turn-lessons.ts).
  try { if (typeof event.transcript_path === "string") fs.appendFileSync(path.join(CACHE_DIR, idx.workspace_id, "ended-turns.jsonl"), JSON.stringify({ sid: sessionId, transcript: event.transcript_path }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
  try {
    // A Cloud folder's ended turns are drained by the MCP server through its Project; the CLI has no store for it.
    if (indexMode(idx) === "cloud" || !["knowledge-observations.jsonl", "auto-activity.jsonl", "ended-turns.jsonl"].some((f) => { try { return fs.statSync(path.join(CACHE_DIR, idx.workspace_id, f)).size > 0; } catch { return false; } })) return;
  } catch { return; }
  spawnMaintenance(idx.workspace_id, "learning", ["learning", "drain", "--workspace", idx.workspace_id, "--quiet"], 2 * 60 * 1000);
}

function shortHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

/** The protocol this session gets: the variant naming no MCP tool when none is attached. */
function sessionProtocolText() {
  const full = typeof index.protocol === "string" && index.protocol.trim().length > 0 ? index.protocol.trim() : null;
  if (!full) return null;
  const withoutMcp =
    typeof index.protocol_without_mcp === "string" && index.protocol_without_mcp.trim().length > 0
      ? index.protocol_without_mcp.trim()
      : null;
  return withoutMcp && !mcpAvailableForSession() ? withoutMcp : full;
}

// ─── Native integrations: notices where nothing is delivered ──────────────────
function noWorkspaceNotice() {
  if (folderConflictRoot) return `Pathrule: ${folderConflictRoot} has both a Local and a Cloud workspace; choose one with \`pathrule setup --cloud\` or \`pathrule setup --local\`.`;
  if (unsupportedIndexSeen) {
    return "Pathrule: this workspace's index was written by a newer Pathrule runtime than the hook installed on this machine, so no Pathrule context is delivered. Run Pathrule setup again to update the runtime.";
  }
  if (process.env.PATHRULE_HOOK_CHANNEL !== "plugin") return null;
  // Said once per folder: the person installed the plugin, so one pointer is help, a repeat is noise.
  const marker = path.join(CACHE_DIR, "hints", crypto.createHash("sha1").update(pathCompareKey(cwd)).digest("hex"));
  try {
    fs.statSync(marker);
    return null;
  } catch {
    // not said here yet
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${cwd}\n`);
  } catch {
    return null;
  }
  const hint = process.env.PATHRULE_PLUGIN_SETUP_HINT || "Pathrule setup";
  return `Pathrule plugin: ${cwd} is not a Pathrule workspace yet, so Pathrule delivers nothing here. To use Pathrule in this folder, the user can run ${hint} for this project. Do not set it up without the user asking.`;
}

// ─── Resolve workspace + index ───────────────────────────────────────────────
// The hook index schemas this hook reads (protocol/hook-index.ts `schema_version`). The runtime
// manifest repeats this list so a launcher can tell a runtime whose hook cannot read its index.
const SUPPORTED_INDEX_SCHEMAS = new Set([1, 2]);
let unsupportedIndexSeen = false;
// The root of a folder with both a Local and a Cloud index and no choice there, for its one notice.
let folderConflictRoot = null;
// An index's edition: the writer stamps `mode`; before that, only a Cloud index carried `cloud_semantic`.
const indexMode = (idx) => (idx.mode === "cloud" || idx.mode === "local" ? idx.mode : idx.cloud_semantic ? "cloud" : "local");

/** The deepest edition choice covering one of `at` (capabilities/folders.json, `pathrule setup`), or null. */
function folderChoice(at) {
  let best = null;
  try {
    const file = JSON.parse(fs.readFileSync(path.join(PATHRULE_HOME, "capabilities", "folders.json"), "utf8"));
    for (const c of file && file.schema === 1 && Array.isArray(file.folders) ? file.folders : []) {
      const covers = c && typeof c.root === "string" && (c.mode === "cloud" || c.mode === "local") && at.some((p) => pathStartsWith(p, c.root));
      if (covers && (!best || c.root.length > best.root.length)) best = c;
    }
  } catch { /* no choice recorded */ }
  return best;
}

/** Folders attached to Pathrule Cloud (config/users/<person>/native-workspaces.json): Cloud's claim, with an index here or not. */
function cloudAttached(at) {
  const users = path.join(PATHRULE_HOME, "config", "users"), out = [];
  try { for (const u of fs.readdirSync(users)) { try {
    const f = JSON.parse(fs.readFileSync(path.join(users, u, "native-workspaces.json"), "utf8"));
    for (const w of f && f.schema_version === 1 && Array.isArray(f.workspaces) ? f.workspaces : []) if (w && typeof w.root === "string" && at.some((p) => pathStartsWith(p, w.root))) out.push({ index: null, root: w.root, rootLen: w.root.length, mode: "cloud" });
  } catch { /* unreadable: none */ } } } catch { /* no attachment */ }
  return out;
}

// One edition per folder, as core's resolveFolderMode (workspace/folder-mode.ts): the deepest choice drops the other
// edition at or above its folder (deeper is a nested project), the longest root left wins, both editions there with no
// choice is a conflict nothing guesses, and a Cloud folder with no Cloud index gets nothing, never a Local index.
function findWorkspaceIndex(currentCwd) {
  let workspaces;
  try {
    workspaces = fs.readdirSync(CACHE_DIR);
  } catch {
    return null;
  }
  const matches = [];
  for (const wsId of workspaces) {
    let index;
    try { index = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, wsId, "hook-index.json"), "utf8")); } catch { continue; }
    // An index this hook cannot read (a newer runtime wrote it) is skipped, never half-read.
    // A missing schema_version is the original format.
    if (index && index.schema_version !== undefined && !SUPPORTED_INDEX_SCHEMAS.has(index.schema_version)) {
      unsupportedIndexSeen = true;
      logLatency("findWorkspaceIndex", null, `index_schema_unsupported:${index.schema_version}`);
      continue;
    }
    const root = index && index.workspace_root;
    if (typeof root === "string" && root.length > 0 && pathStartsWith(currentCwd, root)) matches.push({ index, root, rootLen: root.length, mode: indexMode(index) });
  }
  // A recorded choice is canonical (symlinks resolved); the client's cwd may not be.
  let real = currentCwd;
  try { real = fs.realpathSync(currentCwd); } catch { /* gone: as given */ }
  const choice = folderChoice([currentCwd, real]);
  const all = [...matches, ...cloudAttached([currentCwd, real])];
  const kept = choice ? all.filter((m) => m.rootLen > choice.root.length || m.mode === choice.mode) : all;
  if (kept.length === 0) return null;
  const longest = Math.max(...kept.map((m) => m.rootLen));
  const top = kept.filter((m) => m.rootLen === longest);
  if (top.some((m) => m.mode !== top[0].mode)) {
    folderConflictRoot = top[0].root;
    logLatency("findWorkspaceIndex", null, "folder_mode_conflict");
    return null;
  }
  const served = top.filter((m) => m.index);
  if (served.length > 1) logLatency("findWorkspaceIndex", null, `multi_match_recency_${served.length}`);
  return served.length === 0 ? null : served.reduce((best, m) => (genTime(m.index) > genTime(best.index) ? m : best)).index;
}

function genTime(index) {
  const t = Date.parse(index && index.generated_at ? index.generated_at : "");
  return Number.isFinite(t) ? t : 0;
}

const index = findWorkspaceIndex(cwd);
if (!index) {
  logLatency(eventName, toolName, unsupportedIndexSeen ? "no_workspace_schema" : "no_workspace");
  const notice = eventName === "SessionStart" ? noWorkspaceNotice() : null;
  if (notice) {
    process.stdout.write(
      JSON.stringify(denormalizeOutput({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notice } })) +
        "\n",
    );
    process.exit(0);
  }
  // Count empty events; no_workspace is the most common cause.
  emitEmptyDefended("no_workspace");
}
// Knowledge under an `_archive` node is history, not context (protocol/knowledge-archive.ts). The writer
// drops it; an index written before that must not deliver it either. Reads by id still reach it.
const isArchivedPath = (p) => typeof p === "string" && p.split("/").includes("_archive");
for (const k of ["path_memories", "path_rules", "path_skills"]) for (const p of Object.keys(index[k] ?? {})) if (isArchivedPath(p)) delete index[k][p];

// Merge detector-written fail-patterns.json.
try {
  const fpPath = path.join(CACHE_DIR, index.workspace_id, "fail-patterns.json");
  if (fs.existsSync(fpPath)) {
    const fpParsed = JSON.parse(fs.readFileSync(fpPath, "utf8"));
    if (Array.isArray(fpParsed?.patterns)) index.fail_patterns = fpParsed.patterns;
  }
} catch {
  // ignore — advisory patterns only
}

const workspaceId = index.workspace_id;
const sessionFile =
  sessionStem && workspaceId ? path.join(CACHE_DIR, workspaceId, `session-${sessionStem}.json`) : null;

// Feature flag: pathrule.experiments.rule_promotion_v1
// Stored in hook-index.json under index.experiments.rule_promotion_v1.
// Default OFF; Pathrule team workspace gets it ON first.
const M44_PROMOTION_ENABLED = !!(index.experiments && index.experiments.rule_promotion_v1 === true);

// ─── Session state (dedup ledger) ─────────────────────────────────────────────
//
// Tracks which rule IDs + memory IDs the hook has already injected during
// THIS Claude Code session. Reading is non-destructive; writing uses atomic
// tmp+rename. Parallel tool calls could race on write but the worst case is
// one duplicate injection — cheaper than adding a lockfile.

function readSessionState() {
  const empty = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    injected_rule_ids: [],
    injected_memory_ids: [],
    // CHECK atoms whose scope this session mutated and whose required verification has
    // not passed SINCE that mutation. Entries are added at PreToolUse, cleared when the
    // evidence channel reports a PASS for the fingerprint, and re-added by a later
    // mutation. Stop blocks while this is non-empty.
    pending_checks: [],
    satisfied_checks: [],
    // Memory id → content_hash of memories injected this session. Hash-aware dedup
    // re-injects a memory only when its body changed (edit), and stays silent
    // for unchanged ones so the agent context (and prompt cache) stays stable.
    injected_memory_hashes: {},
    prompt_project_rule_ids: [],
    semantic_candidate_ids: [],
    // Skill names already offered this session. A hint is worth saying once; repeating it
    // every prompt would rebuild the per-prompt tax this channel exists to avoid.
    skill_hint_ids: [],
    // Memory ids offered as NAMES and not yet pulled: a pull of one of these is a relevance
    // label (no learning reads it today).
    name_offered_ids: [],
    // Every id already announced by NAME this session, memory or rule. A name is worth
    // saying once: without this ledger a demoted item is re-announced on every prompt,
    // because only DELIVERED items record their content hash — which turned graduated
    // delivery into the per-prompt tax it exists to remove (session cost measured at
    // -3,6% instead of -13,9% until this was added).
    name_announced_ids: [],
    rule_injection_records: {},
    file_tool_count: 0,
    digest_injected: false,
    // The agent protocol is delivered once per session (it is framing, not
    // knowledge). Absent `index.protocol` means the protocol still lives in the
    // companion files and this flag is never read.
    protocol_injected: false,
    user_prompt_count: 0,
    // Navigation: signature of the last emitted route, so an
    // unchanged route stays silent across prompts (cache-stable); the routed
    // paths + follow flag feed accuracy telemetry; session_paths is the
    // recency signal (paths this session touched, most recent first).
    last_route_signature: null,
    // Body-block delta key = route signature + prompt-intent hash, so an
    // intra-path topic change re-selects while an identical prompt stays silent.
    last_body_intent_sig: null,
    last_route_paths: [],
    route_followed_logged: false,
    session_paths: [],
    // REMEDY advisory refs already delivered this session, so an approved remedy injects once and
    // does not repeat on every tool call. Listed here because readSessionState rebuilds a fixed
    // shape: an unlisted field is silently dropped on the next read.
    delivered_advisory_refs: [],
    // User preference and guidance ids already delivered this session (once per session).
    delivered_user_pref_ids: [],
    // Knowledge gap refs already delivered this session (once per session per gap).
    delivered_gap_refs: [],
    // Runtime indicator lines already delivered this session (scope and counts; once while they hold).
    delivered_runtime_keys: [],
    // Version of the team and personal profile block this session received (once per version).
    delivered_profile_version: null,
  };
  if (!sessionFile) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    return mergeOtherChannelDeliveries(workspaceId, {
      session_id: parsed.session_id ?? sessionId,
      created_at: parsed.created_at ?? empty.created_at,
      last_seen_at: new Date().toISOString(),
      injected_rule_ids: Array.isArray(parsed.injected_rule_ids) ? parsed.injected_rule_ids : [],
      injected_memory_ids: Array.isArray(parsed.injected_memory_ids)
        ? parsed.injected_memory_ids
        : [],
      injected_memory_hashes:
        parsed.injected_memory_hashes && typeof parsed.injected_memory_hashes === "object"
          ? parsed.injected_memory_hashes
          : {},
      prompt_project_rule_ids: Array.isArray(parsed.prompt_project_rule_ids)
        ? parsed.prompt_project_rule_ids
        : [],
      semantic_candidate_ids: Array.isArray(parsed.semantic_candidate_ids)
        ? parsed.semantic_candidate_ids
        : [],
      // readSessionState rebuilds a FIXED shape, so a field that is written but not listed
      // here is silently dropped on the next read. Both of these are cross-prompt ledgers
      // and were invisible until a debug line showed `offered=undefined` on a session file
      // that plainly contained the ids.
      name_offered_ids: Array.isArray(parsed.name_offered_ids) ? parsed.name_offered_ids : [],
      name_announced_ids: Array.isArray(parsed.name_announced_ids) ? parsed.name_announced_ids : [],
      skill_hint_ids: Array.isArray(parsed.skill_hint_ids) ? parsed.skill_hint_ids : [],
      delivered_advisory_refs: Array.isArray(parsed.delivered_advisory_refs) ? parsed.delivered_advisory_refs : [],
      // Written after a delivering prompt; listed so the ledger survives the next read (an
      // unlisted field is dropped, see above).
      delivered_user_pref_ids: Array.isArray(parsed.delivered_user_pref_ids) ? parsed.delivered_user_pref_ids : [],
      delivered_gap_refs: Array.isArray(parsed.delivered_gap_refs) ? parsed.delivered_gap_refs : [],
      delivered_runtime_keys: Array.isArray(parsed.delivered_runtime_keys) ? parsed.delivered_runtime_keys : [],
      delivered_profile_version:
        typeof parsed.delivered_profile_version === "string"
          ? parsed.delivered_profile_version
          : null,
      rule_injection_records:
        parsed.rule_injection_records && typeof parsed.rule_injection_records === "object"
          ? parsed.rule_injection_records
          : {},
      file_tool_count:
        typeof parsed.file_tool_count === "number" && parsed.file_tool_count >= 0
          ? parsed.file_tool_count
          : 0,
      digest_injected: parsed.digest_injected === true,
      protocol_injected: parsed.protocol_injected === true,
      user_prompt_count:
        typeof parsed.user_prompt_count === "number" && parsed.user_prompt_count >= 0
          ? parsed.user_prompt_count
          : 0,
      last_route_signature:
        typeof parsed.last_route_signature === "string" ? parsed.last_route_signature : null,
      last_body_intent_sig:
        typeof parsed.last_body_intent_sig === "string" ? parsed.last_body_intent_sig : null,
      last_route_paths: Array.isArray(parsed.last_route_paths) ? parsed.last_route_paths : [],
      route_followed_logged: parsed.route_followed_logged === true,
      route_guidance_injected: parsed.route_guidance_injected === true,
      transcript_marks: Array.isArray(parsed.transcript_marks) ? parsed.transcript_marks : [],
      session_paths: Array.isArray(parsed.session_paths) ? parsed.session_paths : [],
      // Must be listed here or it is dropped on the next read, exactly as the comment
      // above warns. The CHECK gate wrote it to disk correctly and then read back an
      // empty ledger, so Stop allowed a turn with a verification still owed.
      pending_checks: Array.isArray(parsed.pending_checks) ? parsed.pending_checks : [],
      satisfied_checks: Array.isArray(parsed.satisfied_checks) ? parsed.satisfied_checks.slice(0, 256) : [],
    });
  } catch {
    return mergeOtherChannelDeliveries(workspaceId, empty);
  }
}

function writeSessionState(state) {
  if (!sessionFile) return;
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    // Clamp arrays to cap size — keep the most recent entries.
    const trim = (arr, cap) => (arr.length > cap ? arr.slice(arr.length - cap) : arr);
    const trimmedRuleIds = trim(state.injected_rule_ids, MAX_TRACKED_RULE_IDS);
    const allowedRuleIds = new Set(trimmedRuleIds);
    const records = {};
    for (const [id, record] of Object.entries(state.rule_injection_records ?? {})) {
      if (allowedRuleIds.has(id)) records[id] = record;
    }
    const body = JSON.stringify(
      {
        ...state,
        injected_rule_ids: trimmedRuleIds,
        injected_memory_ids: trim(state.injected_memory_ids, MAX_TRACKED_MEMORY_IDS),
        prompt_project_rule_ids: trim(
          state.prompt_project_rule_ids ?? [],
          MAX_TRACKED_PROMPT_RULE_IDS,
        ),
        semantic_candidate_ids: trim(state.semantic_candidate_ids ?? [], MAX_TRACKED_MEMORY_IDS),
        // Open name-tier offers awaiting a pull. Trimmed like the others so a long session
        // cannot grow the file without bound; the oldest offers are the least likely to be
        // pulled anyway.
        name_offered_ids: trim(state.name_offered_ids ?? [], MAX_TRACKED_MEMORY_IDS),
        name_announced_ids: trim(state.name_announced_ids ?? [], MAX_TRACKED_MEMORY_IDS * 2),
        skill_hint_ids: trim(state.skill_hint_ids ?? [], MAX_TRACKED_MEMORY_IDS),
        rule_injection_records: records,
      },
      null,
      2,
    );
    const tmp = sessionFile + ".tmp";
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, sessionFile);
  } catch {
    // Ignore — dedup will degrade to "inject everything each time" (current behavior).
  }
}

// ─── Keyword relevance scoring ────────────────────────────────────────────────
//
// Minimal bilingual (en + tr) tokenizer + stopword set. Used to drop rules
// whose preview has zero token overlap with the current tool call's content.

const STOPWORDS = new Set([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "about",
  "up",
  "down",
  "out",
  "over",
  "into",
  "not",
  "no",
  "yes",
  "you",
  "your",
  "our",
  "their",
  "its",
  "it",
  "we",
  "us",
  "they",
  "function",
  "const",
  "let",
  "var",
  "import",
  "export",
  "return",
  "async",
  "await",
  // Turkish
  "bir",
  "ve",
  "ile",
  "için",
  "bu",
  "şu",
  "o",
  "ben",
  "sen",
  "biz",
  "siz",
  "onlar",
  "var",
  "yok",
  "olan",
  "olarak",
  "değil",
  "daha",
  "çok",
  "az",
  "her",
  "hiç",
  "bazı",
  "en",
  "de",
  "da",
  "ki",
  "ama",
  "veya",
  "ya",
  "sadece",
  "nasıl",
  "neden",
  "nedir",
  "şey",
  "yine",
  "gibi",
]);

function tokenize(text) {
  if (!text) return new Set();
  const out = new Set();
  const lowered = String(text).toLowerCase();
  // Split on any non-word char (Unicode-aware enough for our corpus).
  const raw = lowered.split(/[^a-z0-9ğıöşüçâîûñé]+/i);
  for (const t of raw) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function keywordOverlap(contextTokens, target) {
  const targetTokens = tokenize(target);
  let hits = 0;
  for (const t of targetTokens) if (contextTokens.has(t)) hits++;
  return hits;
}

const MEMORY_GENERIC_PATH_TOKENS = new Set([
  "app",
  "apps",
  "src",
  "source",
  "component",
  "components",
  "content",
  "package",
  "packages",
  "pathrule",
  "file",
  "update",
  "patch",
  "begin",
  "end",
  "old",
  "new",
  "tsx",
  "jsx",
  "typescript",
  "javascript",
]);

const SEMANTIC_TAG_RULES = [
  [
    "frontend",
    [
      /\/packages\/app\b/i,
      /\b(frontend|front-end|renderer|react|tsx|jsx|component|components|screen|page|view)\b/i,
    ],
  ],
  ["backend", [/\/packages\/mcp-server\b/i, /\b(backend|server|service|api|ipc|worker|queue)\b/i]],
  ["database", [/\b(database|postgres|postgrest|db|sql|rpc|rls|schema)\b/i, /\/supabase\b/i]],
  ["infra", [/\b(infra|deploy|deployment|cloudflare|r2|notarize|notarized|updater)\b/i]],
  ["test", [/\b(test|tests|vitest|playwright|typecheck|lint|eslint|smoke)\b/i]],
  ["docs", [/\b(docs|readme|claude\.md|agents\.md|llms\.txt|documentation)\b/i]],
  ["config", [/\b(config|env|toml|yaml|yml|json|settings|preferences)\b/i]],
  [
    "ui",
    [
      /\b(ui|ux|modal|popover|dialog|button|badge|tab|tree|layout|design|onboarding)\b/i,
      /\b(tasarim|tasarım|ekran|sayfa|gorunum|görünüm|yerlesim|yerleşim|rozet)\b/i,
    ],
  ],
  [
    "design-system",
    [/\b(design system|design-system|tokens?|theme|tailwind|shadcn|visual language)\b/i],
  ],
  ["i18n", [/\b(i18n|translation|translations|locale|localization|hardcoded)\b/i]],
  ["electron", [/\b(electron|main process|renderer|tray|native menu)\b/i]],
  ["mcp", [/\b(mcp|model context protocol|get_context|read_memory|tool surface)\b/i]],
  ["hook", [/\b(hook|hooks|pretooluse|posttooluse|userpromptsubmit|sessionstart)\b/i]],
  ["router", [/\b(router|routing|route|deterministic_route|ai-route)\b/i]],
  ["performance", [/\b(performance|latency|timeout|telemetry|cache|optimize|hiz|hız)\b/i]],
  ["supabase", [/\b(supabase|edge function|edge-function)\b/i, /\/supabase\b/i]],
  ["edge-function", [/\b(edge function|edge-function|functions\/[a-z0-9_-]+)\b/i]],
  ["rls", [/\b(rls|row level security|policy|policies)\b/i]],
  ["auth", [/\b(auth|jwt|session|login|keychain|oauth)\b/i]],
  ["billing", [/\b(billing|subscription|checkout|invoice|payment|usage limit)\b/i]],
  ["stripe", [/\b(stripe|webhook|checkout session|paymentintent)\b/i]],
  ["migration", [/\b(migration|migrations|schema change|alter table)\b/i]],
  ["security", [/\b(security|secret|service role|rls|jwt|permission|access check)\b/i]],
  ["release", [/\b(release|ship|publish|version bump|notarized|signed)\b/i]],
  ["tree", [/\b(tree|collapse|expand|node tree|treetoolbar)\b/i]],
  ["suggestions", [/\b(suggestion|suggestions|suggestionstab|refresh suggestion)\b/i]],
  ["modal", [/\b(modal|dialog|popover|sheet)\b/i]],
  ["skill-package", [/\b(skill package|skill-package|skillpackagetree|skillpackageviewer)\b/i]],
  ["workspace", [/\b(workspace|project root|repo root|node path|root path)\b/i]],
  ["activity", [/\b(activity|activities|recent activity|log_activity|activity log)\b/i]],
  ["cache", [/\b(cache|cached|etag|warm|cold|ttl)\b/i]],
];

const SEMANTIC_GENERIC_TAGS = new Set([
  "frontend",
  "backend",
  "database",
  "infra",
  "ui",
  "config",
  "docs",
  "test",
]);

function inferSemanticTags(text, pathValue) {
  const haystack = `${pathValue ?? ""} ${text ?? ""}`;
  const out = [];
  for (const [tag, patterns] of SEMANTIC_TAG_RULES) {
    if (patterns.some((pattern) => pattern.test(haystack))) out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

function semanticTagScore(contextTags, targetTags) {
  if (!Array.isArray(contextTags) || !Array.isArray(targetTags)) {
    return { score: 0, matches: [] };
  }
  const context = new Set(contextTags);
  const matches = [...new Set(targetTags.filter((tag) => context.has(tag)))];
  if (matches.length === 0) return { score: 0, matches };
  if (matches.length === 1 && SEMANTIC_GENERIC_TAGS.has(matches[0])) {
    return { score: 0, matches: [] };
  }
  return { score: Math.min(12, matches.length * 4), matches };
}

function projectRuleRelevance(rule, contextTokens, contextSemanticTags, contextText) {
  if (!rule || rule.enforcement === "strict") return null;
  if (Array.isArray(rule.symbols) && rule.symbols.length > 0) {
    const symbols = matchingSymbols(rule, contextText);
    if (symbols.length === 0) return null;
    return { score: 20 + symbols.length, reason: "symbol" };
  }
  const overlap = keywordOverlap(contextTokens, `${rule.name} ${rule.preview}`);
  const tagPart = semanticTagScore(contextSemanticTags, rule.semantic_tags);
  const threshold = rule.priority === "high" ? 1 : rule.priority === "medium" ? 2 : 3;
  if (overlap < threshold && !(overlap >= 1 && tagPart.score >= 4)) return null;
  const priorityBonus = rule.priority === "high" ? 4 : rule.priority === "medium" ? 2 : 0;
  return {
    score: overlap * 6 + tagPart.score + priorityBonus,
    reason: tagPart.matches.length > 0 ? `semantic:${tagPart.matches.join(",")}` : "keyword",
  };
}

function selectPromptProjectRules(index, prompt, state, limit = PROMPT_PROJECT_RULE_LIMIT) {
  const rules = Array.isArray(index.project_rules) ? index.project_rules : [];
  if (rules.length === 0 || typeof prompt !== "string" || prompt.trim().length === 0) return [];
  const contextTokens = tokenize(prompt);
  const contextSemanticTags = inferSemanticTags(prompt, cwd);
  const contextText = prompt.toLowerCase();
  const seen = new Set(state.prompt_project_rule_ids ?? []);
  const ranked = [];

  for (const rule of rules) {
    if (!rule || seen.has(rule.id)) continue;
    const relevance = projectRuleRelevance(rule, contextTokens, contextSemanticTags, contextText);
    if (!relevance) continue;
    ranked.push({ rule, score: relevance.score });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const priorityRank = { high: 0, medium: 1, low: 2 };
    return (priorityRank[a.rule.priority] ?? 3) - (priorityRank[b.rule.priority] ?? 3);
  });

  return ranked.slice(0, limit).map((item) => item.rule);
}

function stripPendingRefreshDigest(digest) {
  if (typeof digest !== "string" || digest.length === 0) return digest;
  return digest
    .replace(/^📝 Pathrule memory\/rule refresh tasks waiting:[^\n]*(?:\n\s*){0,2}/, "")
    .trimStart();
}

function pendingRefreshCounts(index) {
  const pending =
    typeof index.pending_refresh_count === "number" && index.pending_refresh_count > 0
      ? index.pending_refresh_count
      : 0;
  const inProgress =
    typeof index.in_progress_refresh_count === "number" && index.in_progress_refresh_count > 0
      ? index.in_progress_refresh_count
      : 0;
  if (pending > 0 || inProgress > 0) return { pending, inProgress };

  const digest = typeof index.session_digest === "string" ? index.session_digest : "";
  const match = digest.match(
    /refresh tasks waiting:\s*(?:(\d+)\s+pending)?(?:,\s*)?(?:(\d+)\s+in progress)?/i,
  );
  if (!match) return { pending: 0, inProgress: 0 };
  return {
    pending: Number.parseInt(match[1] ?? "0", 10) || 0,
    inProgress: Number.parseInt(match[2] ?? "0", 10) || 0,
  };
}

function shouldMentionRefreshTasks(prompt) {
  return REFRESH_MAINTENANCE_RE.test(String(prompt ?? ""));
}

function formatPendingRefreshLine(index) {
  const counts = pendingRefreshCounts(index);
  const parts = [];
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  if (parts.length === 0) return null;
  return `📝 Pathrule refresh tasks waiting: ${parts.join(", ")}. Call \`pathrule_list_pending_refreshes({ workspace_id })\` only if this task is about memory/rule refresh work.`;
}

function semanticTextFromToolInput(text) {
  const value = String(text ?? "");
  if (!value.includes("*** Begin Patch") && !value.includes("@@")) return value;
  return value
    .split(/\r?\n/)
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1))
    .join("\n");
}

function pathDepth(nodePath) {
  if (!nodePath || nodePath === "/") return 0;
  return nodePath.split("/").filter(Boolean).length;
}

function memoryRelevanceScore(contextTokens, target) {
  const targetTokens = tokenize(target);
  let score = 0;
  for (const t of targetTokens) {
    if (!contextTokens.has(t)) continue;
    if (MEMORY_GENERIC_PATH_TOKENS.has(t)) continue;
    score += 1;
  }
  return score;
}

function memoryThreshold(memory, baseThreshold) {
  return pathDepth(memory.node_path) <= 2 ? Math.max(baseThreshold, 2) : baseThreshold;
}

function allMemoryStubs(idx) {
  return allStubs(idx.path_memories);
}

// Flatten path_skills into a workspace-wide skill list (parity with
// allMemoryStubs) for the global semantic candidate pool.
function allSkillStubs(idx) {
  return allStubs(idx.path_skills);
}

function allStubs(byPath) {
  const seen = new Set();
  const out = [];
  for (const bucket of Object.values(byPath ?? {})) {
    for (const s of Array.isArray(bucket) ? bucket : []) {
      if (!s || typeof s.id !== "string" || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

// Path relation as a STRUCTURAL tier, not a token in a bag of words.
//
// Measured 2026-08-23, editing packages/app/src/studio/sidebar/TaskBoardView.tsx: the
// offered memories included "Layers must never unwrap a wrapper into nothing", "Animate
// with AI must read the LIVE document" and "Design final-validation" — Design-surface
// knowledge on a Tasks-board file. The mechanism was not a bad score, it was the score
// being computed over `title + preview + node_path` as TEXT: the file path contributes
// the token "studio", every /studio/** memory's node_path contains it, one token clears
// `lexicalScore * 3 >= 3`, and the item is in.
//
// So node_path stops being matched as text and becomes a multiplier. The tiers are
// ordered by how much a path relation actually predicts relevance: knowledge attached to
// the exact file/dir, then its ancestors (the module's own conventions), then its
// descendants (a rule about a subtree you are editing above), then anywhere else. The
// last tier is deliberately low enough that a single incidental token no longer clears
// the floor from an unrelated subtree, while a genuinely strong match still can.
const PATH_TIER_SAME = 1.0;
const PATH_TIER_ANCESTOR = 0.85;
const PATH_TIER_DESCENDANT = 0.7;
const PATH_TIER_ELSEWHERE = 0.4;

function pathRelationTier(nodePath, relativePath) {
  const node = typeof nodePath === "string" && nodePath.length > 0 ? nodePath : "/";
  if (typeof relativePath !== "string" || relativePath.length === 0) return PATH_TIER_ELSEWHERE;
  const here = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  if (node === here) return PATH_TIER_SAME;
  // Root is an ancestor of everything, but "attached to the whole workspace" is a
  // weaker signal than "attached to this module", so it does not earn the ancestor tier.
  if (node === "/") return PATH_TIER_ELSEWHERE;
  if (here === node || here.startsWith(`${node}/`)) return PATH_TIER_ANCESTOR;
  if (node.startsWith(`${here}/`)) return PATH_TIER_DESCENDANT;
  return PATH_TIER_ELSEWHERE;
}

function selectSemanticMemoryCandidates(params) {
  const limit = params.limit ?? 3;
  if (limit <= 0) return [];
  const seen = new Set();
  const excluded = params.excludeMemoryIds ?? new Set();
  const ranked = [];
  let order = 0;

  for (const memory of allMemoryStubs(params.index)) {
    const currentOrder = order++;
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    if (excluded.has(memory.id)) continue;
    // Hash-aware delta. Skip only when already injected with the SAME body
    // (unchanged → silence, no rotation); an edited memory (new hash) re-surfaces.
    // Falls back to id-based dedup when the index has no content_hash.
    if (memory.content_hash && params.injectedHashes) {
      if (params.injectedHashes[memory.id] === memory.content_hash) continue;
    } else if (params.seenMemoryIds?.has(memory.id)) {
      continue;
    }

    // node_path is NOT in the matched text any more — see pathRelationTier. Leaving it
    // in is what let a file path's own directory names vouch for unrelated knowledge.
    const lexicalScore = keywordOverlap(
      params.contextTokens,
      `${memory.title ?? ""} ${memory.preview ?? ""}`,
    );
    const tagPart = semanticTagScore(params.contextSemanticTags, memory.semantic_tags);
    const tier = pathRelationTier(memory.node_path, params.relativePath);
    const score = (lexicalScore * 3 + tagPart.score) * tier;
    // Floor 3, applied AFTER the tier. One shared token on the same node (3 × 1.0)
    // still qualifies; the same single token from an unrelated subtree (3 × 0.4 = 1.2)
    // no longer does. A strong match elsewhere (two tokens + a tag hit) still can.
    if (score < (params.minScore ?? 3)) continue;

    ranked.push({
      candidate: {
        id: memory.id,
        title: memory.title,
        node_path: memory.node_path,
        content_hash: memory.content_hash,
        confidence: lexicalScore >= 2 || tagPart.score >= 4 ? "high" : "medium",
        reason:
          tagPart.matches.length > 0
            ? `semantic_tag:${tagPart.matches.slice(0, 2).join(",")}`
            : "title_or_preview_overlap",
      },
      score,
      depth: pathDepth(memory.node_path),
      order: currentOrder,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.order - b.order;
  });

  return ranked.slice(0, limit).map((item) => item.candidate);
}

// ─── Navigation Engine v1 ──────────────────────────────────────────────
// Route the agent BEFORE it starts exploring: from the prompt, pick the most
// likely target paths using knowledge-free signals already in the hook index
// (work episodes' paths+subjects, knowledge-bearing path keys, filename
// mentions). Emitted as a soft fence: "start here; widen only if insufficient"
// — positive guidance measurably suppresses exploration turns, a hard ban
// would risk recall. Knowledge-independent: works in a workspace with zero
// memories/rules the moment activity history exists. What the agent does with a route
// (did it go there) is route telemetry, which the cloud extension records.

function selectNavigationRoute(idx, promptTokens, promptText, sessionPaths) {
  const scores = new Map(); // path -> { score, why }
  const pathWords = (p) => String(p).replace(/[/._-]+/g, " ").replace(/\b(\w{3,}?)(?:es|s)\b/g, "$1 $&"); // "reports" also meets "report"
  const bump = (p, points, why) => {
    if (!p || p === "/" || typeof p !== "string") return;
    const cur = scores.get(p) ?? { score: 0, why };
    cur.score += points;
    if (points >= 3) cur.why = why;
    scores.set(p, cur);
  };

  // 1) Direct filename mentions in the prompt — strongest signal.
  const fileMention = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g;
  for (const m of String(promptText ?? "").matchAll(fileMention)) {
    const needle = m[0].split("/").pop();
    if (!needle || needle.length < 4) continue;
    for (const key of [
      ...Object.keys(idx.path_memories ?? {}),
      ...Object.keys(idx.path_rules ?? {}),
    ]) {
      if (key.endsWith(`/${needle}`) || key.includes(`/${needle.replace(/\.[^.]+$/, "")}`)) {
        bump(key, 4, "named in prompt");
      }
    }
    // Also match against recently-worked paths (episodes) — a filename the
    // user names that the team touched recently is a near-certain target.
    for (const ep of idx.work_episode_index ?? []) {
      for (const p of ep.paths ?? []) {
        if (typeof p === "string" && p.endsWith(`/${needle}`)) bump(p, 4, "named in prompt");
      }
    }
  }

  // 2) Work episodes: prompt↔subject overlap routes to the episode's paths.
  for (const ep of idx.work_episode_index ?? []) {
    const overlap = (ep.subjects ?? []).filter((s) => promptTokens.has(String(s).toLowerCase()));
    if (overlap.length === 0) continue;
    for (const p of (ep.paths ?? []).slice(0, 4)) {
      bump(p, 2 + Math.min(overlap.length, 3), "recent team work here");
    }
  }

  // 3) Knowledge-bearing paths whose tokens overlap the prompt.
  for (const key of [
    ...Object.keys(idx.path_memories ?? {}),
    ...Object.keys(idx.path_rules ?? {}),
  ]) {
    const overlap = keywordOverlap(promptTokens, pathWords(key));
    if (overlap >= 1) bump(key, overlap, "team knowledge attached");
  }

  // 4) Hot paths: recent team activity concentrates here.
  for (const hp of idx.hot_paths ?? []) {
    const overlap = keywordOverlap(promptTokens, pathWords(hp.path));
    if (overlap >= 1) bump(hp.path, 1 + Math.min(hp.count ?? 1, 2), "team activity hotspot");
  }

  // 5) Session recency: paths the agent already touched in THIS
  // session outrank cold paths — it is probably continuing the same work area.
  for (const p of sessionPaths ?? []) {
    const overlap = keywordOverlap(promptTokens, pathWords(p));
    if (overlap >= 1) bump(p, 2, "worked here this session");
  }

  // Tightened emission (measured: extra stops on easy tasks cost turns). Strong top signal → at most the top target plus a near-tied runner-up;
  // weak/ambiguous → stay silent (a wrong or padded route is worse than none).
  const ranked = [...scores.entries()]
    .filter(([, v]) => v.score >= 2)
    .sort((a, z) => z[1].score - a[1].score || a[0].localeCompare(z[0]));
  const top = ranked.length > 0 ? ranked[0][1].score : 0;
  const route = top < 3 ? [] : ranked.slice(0, ranked[1] && ranked[1][1].score >= top - 1 ? 2 : 1); // ambiguous: silence
  // 6) Code map: the definitions the prompt's words name, as file:line (names only; built from the checkout).
  // A symbol needs its exact compound name, or two base words worth 12 IDF, so common words never route
  // (measured over the 90 benchmark prompts: lower bars routed "add a new option" to addNewRoute).
  const code = [];
  const words = new Set([...promptTokens].map((t) => idx.code_map?.forms?.[t] ?? t));
  for (const [name, loc, ws] of idx.code_map?.symbols ?? []) {
    const hit = ws.filter((w) => words.has(w));
    const weight = hit.reduce((s, w) => s + (idx.code_map.idf?.[w] ?? 1), 0);
    const exact = /[a-z0-9][A-Z]|_/.test(name) && hit.includes(name.toLowerCase());
    if (exact || (hit.length >= 2 && weight >= 12)) code.push({ path: loc, why: `defines ${name}`, weight: weight + (exact ? 20 : 0) });
  }
  code.sort((a, z) => z.weight - a.weight || a.path.length - z.path.length);
  return [...route.map(([p, v]) => ({ path: p, why: v.why })), ...code.slice(0, 2).map(({ path, why }) => ({ path, why }))];
}

function navigationRouteSignature(route) {
  return route.map((r) => r.path).join("|");
}

// Expected-fact hint for a routed path, taken from the recent-work episode
// summary. Folded into the route block (a verification finding): telling the
// agent WHAT it expects to find at a path is what cut the bounded-look cost.
function episodeSummaryForPath(idx, p) {
  for (const ep of idx.work_episode_index ?? []) {
    if ((ep.paths ?? []).includes(p)) return ep.summary || ep.title || null;
  }
  return null;
}

// The standing instruction under every route (L13: worth ~51% on a bounded look). Said once per
// session: repeated, it was ~200 of ~285 chars per prompt (2026-09-01, 45 prompts), and the durable
// copy lives in the PROTOCOL on SessionStart, which survives a compaction. The flag resets with it.
const ROUTE_STANDING_INSTRUCTION =
  "Read just the relevant part(s) of these file(s), confirm what you need, then act — " +
  "do NOT grep/glob across the repo. Widen only if the routed file(s) prove insufficient.";

function formatNavigationRoute(route, idx, state) {
  const lines = ["🧭 Pathrule route — likely target(s) for this task:"];
  for (const r of route) {
    const expected = idx ? episodeSummaryForPath(idx, r.path) : null;
    lines.push(`- ${r.path}${expected ? ` — expected here: ${expected}` : ""} (${r.why})`);
  }
  if (!state || state.route_guidance_injected !== true) {
    lines.push(ROUTE_STANDING_INSTRUCTION);
    if (state) state.route_guidance_injected = true;
  }
  return lines.join("\n");
}

// At prompt time, deliver the routed path's full BODIES (from the warehouse),
// not just a pointer. This mirrors the PreToolUse body delivery (formatInjectionContext
// + __deltaBody) but on UserPromptSubmit, gated by the navigation route:
//   • content-hash delta — an item whose body was already delivered this session stays
//     silent; an edited one (new hash) re-injects on its next route.
//   • compiled-exclusion — items already in the agent's turn-zero files (knowledge_compiled)
//     are skipped (no double-delivery against the compiled CLAUDE.md/.claude/rules).
//   • whole-item budget — accumulate full bodies up to DELTA_MAX_CONTEXT_CHARS; an item
//     that does not fit is dropped (count surfaced, never silently lost) and, because its
//     hash is NOT recorded, it remains eligible to deliver later.
// This is the only channel that reaches the agent with NO compiled files and NO MCP —
// the case where Pathrule must beat the cached monolithic CLAUDE.md on tokens.
// Pure cosine (hook can't import @pathrule/core); mirrors semantic-rank's
// cosineSimilarity (clamps a non-finite element to 0 so a corrupt stored vector
// never out-ranks a real match).
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  if (ma === 0 || mb === 0) return 0;
  const s = dot / (Math.sqrt(ma) * Math.sqrt(mb));
  return Number.isFinite(s) ? s : 0;
}

const SEMANTIC_INJECT_TOPK = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_INJECT_TOPK ?? "", 10);
  // Default 4: every ranked item ships as a body or a name, and each name is re-read on every later call.
  // At 8 the tail was loosely matched documentation (fastapi, 2026-10-15); the agent pulls past four.
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
})();
// Query↔document cosine for relevant pairs is ~0.50–0.65 on Voyage voyage-3, so
// a floor near 0.45 (semantic-rank's SEMANTIC_QUERY_MIN_SIMILARITY) filters noise
// without cutting true matches. A higher floor cuts true matches → the ranker
// silently falls back to lexical. 0.40, not 0.45: the same memory scores ~0.035 lower
// against the same prompt in another language, and a sweep against the live endpoint
// found 0.40 free on every case that worked at 0.45 while recovering the ones that
// failed; a contentless prompt still got nothing. Below 0.35 topically adjacent items
// arrive and spend budget. A model whose cosine scale sits lower brings its own floor
// (embed-query.cjs `min_similarity`, e.g. qwen3-embedding's 0.30).
// Overridable so the floor can be SWEPT, and the override wins over a model's floor.
const INJECT_MIN_OVERRIDE = (() => {
  const raw = Number.parseFloat(process.env.PATHRULE_INJECT_MIN_SIMILARITY ?? "");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : null;
})();
const SEMANTIC_INJECT_MIN = INJECT_MIN_OVERRIDE ?? 0.4;

// Lexical fallback ranker (no key / no embeddings / timeout): order candidates
// by prompt keyword overlap, stable tie-break by id.
// The keyword-overlap path: the local/OSS edition's ranking (no network, no key)
// and the fallback under every path above it. It used to SORT without DROPPING —
// a candidate sharing not one token with the prompt still came back, just last —
// so nothing gated relevance and the only bound on injected volume was the
// 12.000-char budget. Measured 2026-08-23: 60 prompts accumulated ~157K tokens and
// stopped when the knowledge base ran out, not when relevance did.
//
// The gate is CALIBRATED, not absolute, and that is the whole design. `tokenize`
// matches exact tokens with no stemming, so Turkish inflection does not match
// ("kuralları" never meets "kural") — the same reason this workspace's router
// measurement showed 6 of 10 TR/EN prompt pairs diverging. A hard floor would
// therefore drop genuinely relevant memories whenever morphology defeated the
// tokenizer. So zero-overlap candidates are dropped ONLY when some other candidate
// DID overlap: any overlap at all is the evidence that tokenization produced usable
// signal for this prompt. When nothing overlaps, the signal failed rather than the
// candidates being irrelevant, and the gate stands down instead of making the hook
// go blind.
//
// `lastLexicalFloor` keeps those two outcomes apart, because a single "floored"
// flag could not tell "the gate dropped noise" from "the gate could not read this
// prompt" — and those have opposite fixes.
let lastLexicalFloor = "none";

// Score a candidate against the prompt over its WHOLE BODY, length-normalised.
//
// It used to score `title + preview` only, and measured 2026-08-23 over 8 real
// prompts against this workspace's 248 candidates, that signal does not
// discriminate: the eight selected memories came back with scores like
// [1,1,1,1,1,1,1,1] and [3,3,2,1,1,1,1,1]. A score of 1 means the title shares
// exactly ONE token with the prompt, so the "top-8" was decided by the tie-break —
// `a.c.id < b.c.id`, i.e. UUID order. That is a lottery, not a ranking, and it
// showed: the item ranked #1 by title score had the LOWEST body score of the eight.
//
// Over the same prompts the body score spreads 4-6x (0.067 … 0.288) and picks a
// different, better first item. Bodies cost nothing to reach — `pushCandidate`
// already loads `warehouse[id].body` for every candidate — so the only price is
// tokenising them: measured 30,3 ms for 248 candidates / 1023 KB, against 0,7 ms
// for titles, on a UserPromptSubmit that already takes ~118 ms.
//
// Scoring a PREFIX of each body was measured and rejected (17,3 ms, wrong first pick in 2 of 6 prompts).
// Normalised by sqrt(token count) so a long body cannot win on size alone. With `idf`, a hit counts by
// how rare its token is among the candidates: measured 2026-10-15, "weekly report" pulled three unrelated
// bodies whose shared line said "agreed in the weekly platform sync" — a word in most candidates says nothing.
function promptBodyScore(promptTokens, cand, idf) {
  const bodyTokens = cand._toks ?? (cand._toks = tokenize(`${cand.title ?? ""} ${cand.preview ?? ""} ${cand.body ?? ""}`));
  if (bodyTokens.size === 0) return 0;
  let hits = 0;
  const titleTokens = idf ? (cand._ttoks ??= tokenize(cand.title ?? "")) : null; // a title hit says more than a body hit
  for (const t of bodyTokens) if (promptTokens.has(t)) hits += (idf ? idf(t) : 1) * (titleTokens?.has(t) ? 2 : 1);
  return hits / Math.sqrt(bodyTokens.size);
}

// `boost`, a fixed affinity factor, orders like on the vector path; the score alone decides a match.
function lexicalRankMemories(cands, promptText, boost) {
  const toks = tokenize(promptText ?? ""), df = new Map();
  for (const c of cands) { promptBodyScore(toks, c); for (const t of c._toks) if (toks.has(t)) df.set(t, (df.get(t) ?? 0) + 1); } // document frequency of the prompt's tokens
  const idf = (t) => Math.log(1 + cands.length / (df.get(t) ?? 1));
  const scored = [...cands]
    .map((c) => { const s = promptBodyScore(toks, c, idf); return { c, s, rank: s > 0 ? s * boost(c.id) : 0 }; })
    .sort((a, b) => (b.rank !== a.rank ? b.rank - a.rank : a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
  const matched = scored.filter((x) => x.s > 0); // rarity orders them; a weak match falls to the names tier, never out
  for (const x of scored) x.c._weak = matched.length > 0 && boost(x.c.id) <= 1 && [...x.c._toks].filter((t) => toks.has(t)).length < 2; // one shared word, nothing learned: a name
  lastLexicalFloor = matched.length > 0 ? "applied" : "no_signal";
  return (matched.length > 0 ? matched : scored).map((x) => x.c);
}

// Surfaced for the caller's navigation telemetry (set on each build).
let lastBodySelectOutcome = null;
// Reset per selection so a stale value from an earlier call in the same process can
// never be reported as this prompt's gate decision.
function resetLexicalFloor() {
  lastLexicalFloor = "none";
}

function buildNavigationBodyBlock(route, idx, state, promptText, underPressure = false) {
  const warehouse = loadWarehouse(idx.workspace_id);
  if (!warehouse || Object.keys(warehouse).length === 0) return null;
  const decisions = deliveryDecisions;
  const injectedHashes = state.injected_memory_hashes ?? {};
  const deliveredAdvisoryRefs = new Set(Array.isArray(state.delivered_advisory_refs) ? state.delivered_advisory_refs : []);
  // Slim router clients (Claude): memory/skill bodies are NOT in the file
  // (title index only), so the hook is the body channel + ranks top-k. Rule
  // bodies ARE in the slim file (floored) → skip re-injecting them. Full clients
  // keep today's behavior byte-identical.
  const slim = clientShape === "claude";
  const compiledRuleIds = new Set(Array.isArray(idx.compiled_rule_ids) ? idx.compiled_rule_ids : []);
  const compiledIds = new Set(
    idx.knowledge_compiled === true && Array.isArray(idx.compiled_memory_ids)
      ? idx.compiled_memory_ids
      : [],
  );

  const seen = new Set();
  const ruleItems = [];
  const ruleNameItems = [];
  const memCandidates = [];
  // Rules stay path-scoped + project (floored, path-active). On slim, a rule
  // already in the turn-zero file is skipped.
  const rulePromptTokens = tokenize(promptText ?? "");
  const ruleCandidates = [];
  for (const r of route) {
    for (const rl of matchRulesForPath(idx, r.path, 12)) {
      if (seen.has(rl.id)) continue;
      seen.add(rl.id);
      if (slim && compiledRuleIds.has(rl.id)) continue;
      const entry = warehouse[rl.id];
      if (!entry || typeof entry.body !== "string" || entry.body.length === 0) continue;
      const hash = entry.content_hash ?? null;
      if (hash && injectedHashes[rl.id] === hash) continue;
      const strict = rl.enforcement === "strict";
      ruleCandidates.push({
        id: rl.id,
        label: `${strict ? "🚨 Strict rule" : "Rule"}: ${rl.name}`,
        body: entry.body,
        hash,
        preview: rl.preview ?? "",
        strict,
        // Same scorer as memories, so rule and memory relevance are on one scale, times the
        // structural path tier. Scoring over the whole body rather than the title is what
        // makes this discriminate at all: rule TITLES are short and nearly always share a
        // token or none.
        score:
          promptBodyScore(rulePromptTokens, { title: rl.name, preview: rl.preview, body: entry.body }) *
          pathRelationTier(rl.node_path, r.path),
      });
    }
  }
  // Strict first: a strict rule blocks a tool call, and a name cannot explain a block. Then
  // by relevance, so the bodies that ship are the ones this prompt is about.
  ruleCandidates.sort((a, b) =>
    a.strict !== b.strict
      ? a.strict
        ? -1
        : 1
      : b.score !== a.score
        ? b.score - a.score
        : a.id < b.id
          ? -1
          : 1,
  );
  const topRuleScore = ruleCandidates.length > 0 ? Math.max(...ruleCandidates.map((r) => r.score)) : 0;
  const ruleBodyBar = topRuleScore * BODY_RELATIVE_BAR;
  // Only NON-strict bodies count toward the cap. A strict rule is exempt because it blocks
  // tool calls, but letting it consume the cap would mean one strict rule silently demotes
  // the rule the prompt is actually about — a rule that is exempt from the limit must not
  // also spend it.
  let gradedRuleBodies = 0;
  const announced = new Set(Array.isArray(state?.name_announced_ids) ? state.name_announced_ids : []);
  for (const rc of ruleCandidates) {
    const earnsBody =
      rc.strict || ((topRuleScore <= 0 || rc.score >= ruleBodyBar) && gradedRuleBodies < RULE_BODY_COUNT_MAX);
    if (earnsBody && !rc.strict) gradedRuleBodies++;
    if (earnsBody) {
      ruleItems.push({ id: rc.id, label: rc.label, body: rc.body, hash: rc.hash });
    } else if (!announced.has(rc.id)) {
      // A name is worth saying once. Repeating it every prompt is the tax graduated
      // delivery removes; a rule that later becomes relevant still earns its BODY, which is
      // the delivery that actually adds something.
      ruleNameItems.push({ id: rc.id, label: rc.label, preview: rc.preview });
    }
  }
  // Memory/skill candidate pool. SLIM clients use a GLOBAL pool (all
  // workspace memories + skills, route-independent): the prompt-cosine top-k
  // below finds the right slice by MEANING, so a weak-token prompt ("db
  // package") can no longer be mis-routed to the wrong path (the routing miss
  // that cost the multi-turn benchmark). FULL clients keep the route-scoped pool
  // (byte-identical; their bodies live in files anyway).
  const pushCandidate = (id, title, preview) => {
    if (seen.has(id)) return;
    const entry = warehouse[id];
    if (!entry || typeof entry.body !== "string" || entry.body.length === 0) return;
    const hash = entry.content_hash ?? null;
    if (hash && injectedHashes[id] === hash) return;
    // A memory delivered as its compiled form (the warehouse body IS that form) whose every line already
    // reached this session through the advisory channel would only repeat those lines as a body.
    const compiledRefs = Array.isArray(entry.compiled_refs) && entry.compiled_refs.length > 0 ? entry.compiled_refs : null;
    if (compiledRefs && compiledRefs.every((r) => deliveredAdvisoryRefs.has(r))) return;
    seen.add(id);
    memCandidates.push({ id, title, preview, body: entry.body, hash, compiledRefs });
  };
  // Skills are collected SEPARATELY and never enter the body pool.
  //
  // They used to be pushed into memCandidates exactly like memories, which made them
  // eligible for full-body injection. Measured 2026-08-23 across this workspace's 47
  // skills: average body 4.974 chars, largest 51.013 (`pathrule-release`, ~12.753 tokens
  // — four times the entire body budget), and 27 of 47 larger than the average memory.
  //
  // Size is the smaller half of the problem. A memory is a FACT and a rule is a
  // CONSTRAINT, but a skill body is a PROCEDURE. Injecting one unasked does not inform
  // the agent, it instructs it — and an instruction that arrived because a title shared
  // a token with the prompt is how an agent ends up following a release checklist during
  // a bug fix. Cheapest way to lose the plot.
  //
  // So a skill is offered by NAME only, hedged, and never as a directive. The one path to
  // a full skill body stays the explicit `::skill-name` invocation, which is a hard gate
  // the protocol already defines and the user already relies on.
  //
  // PATHRULE_SKILL_HINTS=off removes even the names. Kept as a switch rather than a
  // rewrite because "does naming a skill distract the agent" is an empirical question,
  // and the answer should be a measurement, not a guess.
  const skillHintsEnabled = String(process.env.PATHRULE_SKILL_HINTS ?? "on").toLowerCase() !== "off";
  const skillHintSeen = new Set(Array.isArray(state?.skill_hint_ids) ? state.skill_hint_ids : []);
  const skillHints = [];
  const collectSkillHints = (stubs) => {
    if (!skillHintsEnabled) return;
    for (const sk of stubs) {
      if (!sk || typeof sk.id !== "string" || skillHints.length >= SKILL_HINT_LIMIT) continue;
      if (skillHintSeen.has(sk.id)) continue;
      skillHintSeen.add(sk.id);
      skillHints.push({ id: sk.id, name: sk.name, preview: sk.preview });
    }
  };

  if (slim) {
    const asInstructions = instructionMemoryIds(idx); // Claude already holds these as path-scoped rules
    for (const m of allMemoryStubs(idx)) if (!asInstructions.has(m.id)) pushCandidate(m.id, m.title, m.preview);
    collectSkillHints(allSkillStubs(idx));
  } else {
    for (const r of route) {
      for (const m of matchMemoriesForPath(idx, r.path, 12)) {
        if (compiledIds.has(m.id)) continue;
        pushCandidate(m.id, m.title, m.preview);
      }
    }
  }

  // Rank memory candidates by relevance to the prompt (cosine) and keep
  // the best above the floor, capped at top-k. The floor — NOT the candidate
  // count — is the relevance gate, so it runs whenever there are candidates:
  // gating it on "more than top-k" would let a small candidate set bypass the
  // floor and inject irrelevant bodies. No key / no vectors / timeout → lexical
  // fallback. Rules are never relevance-dropped.
  let rankedMems = memCandidates;
  // id → relevance, filled by whichever ranking branch runs. The ranked list itself
  // carries only order, and order alone cannot say whether item 4 is nearly as relevant
  // as item 1 or nothing like it — which is exactly the question graduated delivery asks.
  const memScore = new Map();
  // Server-ranked candidates with no local body. Offered by name so a correct server answer
  // is never thrown away just because the client's warehouse is a slice.
  const cloudOnlyNames = [];
  if (slim && memCandidates.length > 0) {
    // A signed-in cloud account ranks over the hosted index (the cloud extension); everything
    // else ranks here, with the person's own embedding key or by keyword overlap. Hosted
    // ranking goes first on purpose: ranking is part of what a paid account gets, so a cloud
    // caller must not substitute its own provider key.
    const cloud = isLocalWorkspace(workspaceId) ? null : cloudExtension();
    const ranked = promptText
      ? ((cloud &&
          cloud.rankPrompt({
            index: idx,
            text: promptText,
            limit: SEMANTIC_INJECT_TOPK,
            minSimilarity: SEMANTIC_INJECT_MIN,
          })) ??
        embedPromptVec(promptText))
      : { vec: null, candidates: null, outcome: "fallback_empty" };
    const pv = withSameSpace(ranked, idx);
    lastBodySelectOutcome = pv.outcome;
    resetLexicalFloor();
    // The prompt this ranking served (a no-op decision today).
    if (promptText) decisions.notePromptIntent(promptText, pv.vec);
    // The embeddings map is only ever read against a LOCAL query vector, so it must
    // not be parsed until there is one. Measured 2026-08-23: on a cloud account the
    // local vector came back `fallback_no_key` on 56 of 56 injections (embed-query.cjs
    // wants the caller's OWN key, which is the local edition's deal), so the previous
    // eager load parsed a 2,98 MB embeddings.json on EVERY hook event and discarded it.
    // The cloud path never needs it at all: the server ranks.
    const embeddings = pv.vec ? loadEmbeddings(idx.workspace_id) : null;

    // Server-ranked path. The ranking service already applied the relevance floor and
    // its affinity weight, so there is nothing to recompute here and no reason to read
    // embeddings.json at all: order by the rank it returned and keep the ones we
    // actually hold a body for.
    if (pv.candidates) {
      pv.candidates = pv.candidates.filter((c) => !isArchivedPath(c.node_path));
      const byId = new Map(memCandidates.map((c) => [c.id, c]));
      for (const c of pv.candidates) memScore.set(c.id, c.similarity);
      const cloudRoutePath = route.length > 0 ? route[0].path : "";
      const ordered = [...pv.candidates]
        .map((c) => ({
          c,
          // similarity × path tier × the affinity boost. The tier is what the server
          // no longer applies: it recalls globally now, and the structural path relation
          // decides ordering here, on the same scale as the lexical path uses.
          rank:
            c.similarity *
            pathRelationTier(c.node_path, cloudRoutePath) *
            decisions.serverAffinityBoost(c.affinity),
        }))
        .sort((a, b) =>
          b.rank !== a.rank ? b.rank - a.rank : a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0,
        )
        .map((x) => byId.get(x.c.id))
        .filter(Boolean);
      rankedMems = ordered.slice(0, SEMANTIC_INJECT_TOPK);
      // Candidates the server ranked but whose BODY we do not hold locally. Returning
      // nothing here was wrong: the server had found the right knowledge and the client
      // discarded the answer. Offer them by name from the server's own metadata — the id is
      // enough for the agent to fetch one, and it costs ~60 chars instead of the round-trip
      // being lost entirely. Falling back to keyword overlap is still refused: that would
      // undo the relevance floor we just paid 2 s for.
      for (const c of pv.candidates) {
        if (byId.has(c.id)) continue;
        const title = typeof c.title === "string" && c.title.length > 0 ? c.title : null;
        if (!title) continue;
        if (cloudOnlyNames.some((n) => n.id === c.id)) continue;
        cloudOnlyNames.push({ id: c.id, label: title, preview: c.node_path ?? "" });
      }
      if (ordered.length === 0) {
        lastBodySelectOutcome = cloudOnlyNames.length > 0 ? "cloud_names_only" : "cloud_below_threshold";
      }
    } else if (pv.vec && embeddings && Object.keys(embeddings).length > 0) {
      const scored = [];
      for (const c of memCandidates) {
        const vec = embeddings[c.id];
        if (!vec) continue;
        const score = cosineSim(pv.vec, vec);
        // The FLOOR tests the raw similarity, never the boosted value. Affinity must not
        // be able to push a memory past the relevance bar: that would add bodies to the
        // prompt, and the point of learning is a better pick at the same cost.
        if (score < (INJECT_MIN_OVERRIDE ?? pv.minSimilarity ?? SEMANTIC_INJECT_MIN)) continue;
        scored.push({
          c,
          score,
          rank: score * decisions.learnedAffinityBoost(idx.workspace_id, c.id),
        });
      }
      scored.sort((a, b) =>
        b.rank !== a.rank ? b.rank - a.rank : a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0,
      );
      for (const x of scored) memScore.set(x.c.id, x.score);
      rankedMems = scored.slice(0, SEMANTIC_INJECT_TOPK).map((x) => x.c);
      if (rankedMems.length === 0) {
        // All below threshold / no matching vectors → don't go empty; fall back.
        lastBodySelectOutcome = "fallback_below_threshold";
        rankedMems = lexicalRankMemories(memCandidates, promptText, (id) => decisions.learnedAffinityBoost(idx.workspace_id, id)).slice(0, SEMANTIC_INJECT_TOPK);
      }
    } else {
      rankedMems = lexicalRankMemories(memCandidates, promptText, (id) => decisions.learnedAffinityBoost(idx.workspace_id, id)).slice(0, SEMANTIC_INJECT_TOPK);
    }
    // The lexical ranker returns order, not scores. Recomputing for the <=8 survivors is
    // cheap (the expensive part, tokenising every candidate body, already happened) and it
    // keeps one scoring function as the single source of truth for both order and tier.
    if (memScore.size === 0) {
      const gradeTokens = tokenize(promptText ?? "");
      for (const c of rankedMems) memScore.set(c.id, promptBodyScore(gradeTokens, c));
    }
  } else {
    lastBodySelectOutcome = slim ? "no_rank_needed" : "full_client";
  }

  // GRADUATED DELIVERY. Relevance decides the FORM, not just the order.
  //
  // Every ranked memory used to ship whole, so the budget filled with bodies whose
  // relevance ranged from obvious to incidental and then dropped 1-8 further items for
  // want of space. Measured 2026-08-23 on 8 real prompts: scores like [0.288, 0.267,
  // 0.182, 0.114, 0.111, 0.106, 0.067, 0.059] all received identical treatment.
  //
  // Now the head keeps its body and the tail is offered by name + id + one line. A name
  // costs ~60 chars against a body's ~1.400, and it is not a downgrade to nothing: the
  // agent reads the title, decides for itself, and pulls what it wants. That also makes
  // the choice OBSERVABLE — an offered name that gets pulled is the first honest
  // relevance label this system has ever been able to collect, because a pushed body
  // never produced one.
  const announcedMem = new Set(Array.isArray(state?.name_announced_ids) ? state.name_announced_ids : []);
  const topMemScore = rankedMems.length > 0 ? (memScore.get(rankedMems[0].id) ?? 0) : 0;
  const bodyBar = topMemScore * BODY_RELATIVE_BAR;
  const memItems = [];
  const memNameItems = [];

  // A memory marked proven (the agent pulled it after an offer by name) earns its body
  // back: it clears the bar and takes a body slot ahead of rank. None is marked today.
  const proven = decisions.provenMemoryIds(idx && idx.workspace_id ? idx.workspace_id : null, rankedMems.map((m) => m.id));
  // Two passes so a proven memory cannot be squeezed out by a higher-ranked unproven one,
  // while relevance still decides who fills the slots that remain.
  const bodyOrder = [...rankedMems.filter((m) => proven.has(m.id)), ...rankedMems.filter((m) => !proven.has(m.id))];
  for (const m of bodyOrder) {
    const score = memScore.get(m.id) ?? 0;
    // No score at all (no ranking ran) means no basis for CHOOSING which bodies to keep,
    // so the bar stands down and order decides. The COUNT cap still applies, and that is
    // deliberate: a prompt the scorer cannot read is the worst case to spend eight bodies
    // on — maximum cost, zero confidence — and the remainder is still offered by name.
    // A proven memory clears the bar by having been asked for; re-testing it against a
    // similarity threshold would just re-litigate a question the agent already answered.
    const clearsBar = proven.has(m.id) || ((topMemScore <= 0 || score >= bodyBar) && m._weak !== true);
    if (clearsBar && memItems.length < BODY_COUNT_MAX) {
      memItems.push({ id: m.id, label: m.title, body: m.body, hash: m.hash, compiledRefs: m.compiledRefs });
    } else if (!announcedMem.has(m.id)) {
      memNameItems.push({ id: m.id, label: m.title, preview: m.preview });
    }
  }

  // Server-ranked candidates we hold no body for, offered by name. Placed AFTER the loop
  // above because memNameItems is a `const` declared inside it — pushing earlier was a
  // temporal-dead-zone throw that only fired when the cloud path returned an id the local
  // warehouse did not have, which no test covered.
  for (const c of cloudOnlyNames) {
    if (announcedMem.has(c.id)) continue;
    if (memNameItems.some((n) => n.id === c.id)) continue;
    memNameItems.push(c);
  }

  // The order the budget is spent in: rules, then memories. A strict rule leads either
  // way.
  const strictRuleIds = new Set(ruleCandidates.filter((r) => r.strict).map((r) => r.id));
  const order = decisions.orderBodyItems({ ruleItems, memItems, lexicalFloor: lastLexicalFloor });
  const items = reconcileBodyOrder(order, [...ruleItems, ...memItems], strictRuleIds);
  // The name tier counts as content. Returning null here when every memory was demoted
  // would throw away the cheap half of graduated delivery and look, from the outside,
  // exactly like "nothing was relevant".
  if (items.length === 0 && memNameItems.length === 0 && ruleNameItems.length === 0) return null;

  const header =
    "📚 Pathrule knowledge most relevant to this prompt (authoritative — answer from this, no file/MCP round-trip needed):";
  const lines = [header, ""];
  const delivered = [];
  let used = header.length + 2;
  let dropped = 0;
  const droppedItems = [];
  const bodyBudget = Math.min(decisions.promptBudget(promptText, underPressure), promptBodyCap);
  const strictBudget = Math.max(bodyBudget, Math.min(DELTA_MAX_CONTEXT_CHARS, promptBodyCap)); // a strict rule is never shed
  for (const it of items) {
    const block = `### ${it.label}\n${it.body}\n`;
    const memoryBudget = delivered.length === 0 ? Math.max(bodyBudget, DELTA_MAX_CONTEXT_CHARS) : bodyBudget; // rules keep the full cap
    if (used + block.length > (strictRuleIds.has(it.id) ? strictBudget : ruleItems.includes(it) ? Math.min(DELTA_MAX_CONTEXT_CHARS, promptBodyCap) : memoryBudget)) {
      dropped++;
      droppedItems.push(it);
      continue;
    }
    lines.push(`### ${it.label}`);
    lines.push(it.body);
    lines.push("");
    used += block.length + 1;
    delivered.push(it);
  }
  // A memory that WON a body slot on relevance and then lost it to the char budget must
  // fall back to a NAME, not vanish.
  //
  // Measured on the real workspace: three memories ranked, all three cleared the body bar,
  // and all three were dropped because seven rule bodies had already taken 11.033 of the
  // 12.000 chars. They appeared only inside the overflow sentence — no id, so unreachable,
  // and outside `memNameItems`, so invisible to the learning loop. Demoting them here
  // costs ~60 chars each and restores both.
  const deliveredIdSet = new Set(delivered.map((it) => it.id));
  for (const it of memItems) {
    if (deliveredIdSet.has(it.id)) continue;
    if (memNameItems.some((n) => n.id === it.id)) continue;
    const source = rankedMems.find((m) => m.id === it.id);
    memNameItems.push({ id: it.id, label: it.label, preview: source ? source.preview : "" });
  }
  // Same for a rule whose body lost the race. A rule must never become invisible, and the
  // overflow sentence carries no id, so it would have been exactly that.
  for (const it of ruleItems) {
    if (deliveredIdSet.has(it.id)) continue;
    if (ruleNameItems.some((n) => n.id === it.id)) continue;
    const source = ruleCandidates.find((r) => r.id === it.id);
    ruleNameItems.push({ id: it.id, label: it.label, preview: source ? source.preview : "" });
  }

  if (delivered.length === 0 && memNameItems.length === 0 && ruleNameItems.length === 0) return null;

  // Gated diagnostic. The budget split is not observable from the injected block
  // itself: a prompt that shipped only rules looks exactly like a prompt where no
  // memory was relevant. Measuring the difference is what showed that rules were
  // taking 91,4% of the budget and the top-scoring memory shipped in 2 of 8
  // prompts. Off by default, one stderr line when asked, so the next person does
  // not have to patch a temporary copy of this file to find that out again.
  if (process.env.PATHRULE_BODY_PROBE === "1") {
    const probeTokens = tokenize(promptText ?? "");
    const rankIndex = new Map(rankedMems.map((m, i) => [m.id, i]));
    const byId = new Map(rankedMems.map((m) => [m.id, m]));
    const deliveredIds = new Set(delivered.map((d) => d.id));
    process.stderr.write(
      "PATHRULE_BODY_PROBE " +
        JSON.stringify({
          select: lastBodySelectOutcome,
          floor: lastLexicalFloor,
          budget: bodyBudget,
          used,
          dropped,
          rows: items.map((it) => ({
            id: it.id,
            label: String(it.label ?? "").slice(0, 70),
            kind: rankIndex.has(it.id) ? "memory" : "rule",
            rank: rankIndex.has(it.id) ? rankIndex.get(it.id) : null,
            score: byId.has(it.id)
              ? Number(promptBodyScore(probeTokens, byId.get(it.id)).toFixed(4))
              : null,
            chars: String(it.body ?? "").length,
            delivered: deliveredIds.has(it.id),
          })),
        }) +
        "\n",
    );
  }
  if (dropped > 0) {
    // NAME what was dropped. The old line gave a count and two tool names, which
    // told the agent something was withheld without telling it what — and you
    // cannot fetch what you cannot name, so a dropped item was effectively lost.
    // Measured 2026-08-23: 6-9 items are dropped per prompt because rules take
    // 91,4% of the budget, so this was the common case, not an edge one.
    //
    // Titles only, never bodies: a title is ~60 chars against a body's ~1.400, and
    // the protocol's own fast path is pathrule_resolve(<title>) → id in one step.
    // This is what makes the budget a DEFERRAL instead of a silent loss, and it is
    // the reason a reserved memory displacing a rule body is a survivable trade.
    // Memories that were dropped now appear in the name tier WITH their id, so repeating
    // them here would pay twice for the same item. Only what has no other mention is named.
    const namedIds = new Set([...memNameItems, ...ruleNameItems].map((n) => n.id));
    const overflowNamed = droppedItems.filter((it) => !namedIds.has(it.id));
    // Not an early return: the name tier, the skill hints and the attribution all render
    // after this point, and skipping them would trade one line for the whole tail.
    if (overflowNamed.length > 0) {
      const named = overflowNamed
        .map((it) => `"${String(it.label ?? "").replace(/\s+/g, " ").slice(0, 80)}"`)
        .join(", ");
      lines.push(
        `(${overflowNamed.length} item(s) exceeded the inline budget and were NOT sent: ${named}. ` +
          `Fetch any you need with pathrule_resolve(<title>) then pathrule_read_memory(id) / pathrule_read_rule(id).)`,
      );
    }
  }

  lastBodyDelivered = delivered.map((it) => ({
    id: it.id,
    hash: it.hash ?? null,
    kind: warehouse[it.id] && warehouse[it.id].type === "rule" ? "rule" : warehouse[it.id] && warehouse[it.id].type === "skill" ? "skill" : "memory",
    block: `### ${it.label}\n${it.body}`,
  }));
  // Record delivered hashes/ids so the same body stays silent next prompt (delta).
  // Dropped items are intentionally NOT recorded → still eligible to deliver later.
  if (!state.injected_memory_hashes) state.injected_memory_hashes = {};
  if (!Array.isArray(state.injected_memory_ids)) state.injected_memory_ids = [];
  for (const it of delivered) {
    if (it.hash) state.injected_memory_hashes[it.id] = it.hash;
    if (!state.injected_memory_ids.includes(it.id)) state.injected_memory_ids.push(it.id);
  }
  // A compiled body is made of advisory lines: record them like the advisory channel does, so that
  // channel does not repeat them and the delivery ledger sees them.
  const compiledShipped = delivered.flatMap((it) => (Array.isArray(it.compiledRefs) ? it.compiledRefs : []));
  if (compiledShipped.length > 0) {
    state.delivered_advisory_refs = [...new Set([...(state.delivered_advisory_refs ?? []), ...compiledShipped])];
    recordRemedyDeliveries(idx.workspace_id, sessionId, null, compiledShipped);
  }
  // This is the real delivery event for memory BODIES.
  // Only the ranked MEMORIES are passed: `delivered` also carries rules.
  const rankedIds = new Set(rankedMems.map((m) => m.id));
  const deliveredRanked = delivered.filter((it) => rankedIds.has(it.id)).map((it) => it.id);
  decisions.recordDelivery(idx && idx.workspace_id ? idx.workspace_id : null, sessionId, deliveredRanked);

  // Rule names come FIRST in the name tier. A constraint the agent has not read yet is
  // more urgent to notice than a memory it has not read yet, and the wording says what to
  // do about it rather than leaving the agent to guess whether a name is binding.
  if (ruleNameItems.length > 0) {
    lines.push(
      "**Rules in scope, names only — these BIND even where the body is not shown; read one before acting against it:**",
    );
    for (const it of ruleNameItems) {
      const oneLine = String(it.preview ?? "").replace(/\s+/g, " ").slice(0, 110);
      lines.push(`- ${it.label} (id: ${it.id})${oneLine ? ` — ${oneLine}` : ""}`);
    }
    lines.push("");
  }

  // The NAME tier: everything that ranked but did not clear the body bar. One line each,
  // with the id, so the agent can pull any of them. This is the half of graduated
  // delivery that keeps it from being a plain cut: nothing became unreachable, it became
  // cheaper to offer.
  if (memNameItems.length > 0) {
    lines.push("**Also scoped here (names only — pull a body if you decide it matters):**");
    for (const it of memNameItems) { // every ranked item stays reachable: title and id, no preview
      lines.push(`- ${it.label} (id: ${it.id})`);
    }
    lines.push("");
  }

  // Skill hints: names, hedged, once per session, and only alongside real knowledge.
  //
  // The wording is the feature. "Skills that MIGHT apply" and "read one only if you
  // decide it does" leave the judgement with the agent; "use this skill" would hand a
  // procedure to a model that never asked for one, on the strength of a token overlap.
  // A bare menu of procedures with no other knowledge attached is itself a distraction,
  // which is why this rides along and never justifies a block on its own.
  //
  // Cost: one line, name + id per skill. Against a measured average skill body of 4.974
  // chars (largest 51.013) that is the difference between a pointer and a takeover.
  if (skillHints.length > 0) {
    const named = skillHints.map((sk) => `${sk.name} (id: ${sk.id})`).join(" · ");
    lines.push(
      `(Skills on this path that MIGHT apply — read one only if you decide it does, ` +
        `via pathrule_read_skill(id): ${named})`,
    );
    if (!Array.isArray(state.skill_hint_ids)) state.skill_hint_ids = [];
    for (const sk of skillHints) {
      if (!state.skill_hint_ids.includes(sk.id)) state.skill_hint_ids.push(sk.id);
    }
  }

  // Record the open offers. Only the NAME tier: a body was already delivered, so reading it
  // again proves nothing about relevance. This is the set a pull credit would join
  // against on the next prompt.
  if (memNameItems.length > 0) {
    if (!Array.isArray(state.name_offered_ids)) state.name_offered_ids = [];
    for (const it of memNameItems) {
      if (!state.name_offered_ids.includes(it.id)) state.name_offered_ids.push(it.id);
    }
  }

  // Announce-once ledger, for BOTH kinds. Written after render so a name that was actually
  // shown is the only thing recorded.
  if (memNameItems.length > 0 || ruleNameItems.length > 0) {
    if (!Array.isArray(state.name_announced_ids)) state.name_announced_ids = [];
    for (const it of [...memNameItems, ...ruleNameItems]) {
      if (!state.name_announced_ids.includes(it.id)) state.name_announced_ids.push(it.id);
    }
  }

  return lines.join("\n");
}

const DISCOVERY_PROMPT_RE =
  /\b(what|which|where|show|list|find|inventory|architecture|debug|how does|how do|neler|hangi|nerede|listele|goster|göster|bul|mimari|varyant|variant|debug|hata)\b/i;

function shouldInjectSemanticPromptCandidates(prompt) {
  const text = String(prompt ?? "");
  if (text.trim().length < 6) return false;
  return DISCOVERY_PROMPT_RE.test(text);
}

function fileExtension(relativePath) {
  const ext = path.extname(relativePath || "");
  return ext || "(none)";
}

function pathFamily(relativePath) {
  if (!relativePath || relativePath === "/") return "/";
  const dirname = path.dirname(relativePath);
  if (!dirname || dirname === ".") return "/";
  const parts = dirname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return "/" + parts.slice(0, 3).join("/");
}

function matchingSymbols(rule, contextText) {
  if (!Array.isArray(rule.symbols) || rule.symbols.length === 0) return [];
  return rule.symbols
    .filter((s) => typeof s === "string" && s.length > 0 && contextText.includes(s))
    .sort();
}

function isAdvisoryRuleRelevant(rule, contextTokens, contextSemanticTags, contextText) {
  if (Array.isArray(rule.symbols) && rule.symbols.length > 0) {
    return matchingSymbols(rule, contextText).length > 0;
  }
  const threshold = rule.priority === "high" ? 1 : rule.priority === "medium" ? 2 : 3;
  const overlap = keywordOverlap(contextTokens, `${rule.name} ${rule.preview}`);
  const tagPart = semanticTagScore(contextSemanticTags, rule.semantic_tags);
  return overlap >= threshold || (overlap >= 1 && tagPart.score >= 4);
}

function ruleEventSignature(rule, relativePath, contextText, failPatterns) {
  const symbols = matchingSymbols(rule, contextText);
  return [
    `path:${pathFamily(relativePath)}`,
    `ext:${fileExtension(relativePath)}`,
    `symbols:${symbols.length > 0 ? symbols.join(",") : "-"}`,
    `fail:${failPatterns.length > 0 ? "1" : "0"}`,
  ].join("|");
}

function shouldSafetyReinject(record, state, nowMs) {
  if (!record || typeof record !== "object") return false;
  const lastCount =
    typeof record.last_file_tool_count === "number" && record.last_file_tool_count >= 0
      ? record.last_file_tool_count
      : state.file_tool_count;
  if (state.file_tool_count - lastCount >= REINJECT_AFTER_TOOL_CALLS) return true;

  const lastAtMs = typeof record.last_at === "string" ? Date.parse(record.last_at) : NaN;
  if (!Number.isFinite(lastAtMs)) return false;
  return nowMs - lastAtMs >= REINJECT_AFTER_MINUTES * 60 * 1000;
}

function markRuleInjected(state, ruleId, eventSignature, nowIso) {
  if (!Array.isArray(state.injected_rule_ids)) state.injected_rule_ids = [];
  if (!state.injected_rule_ids.includes(ruleId)) state.injected_rule_ids.push(ruleId);
  if (!state.rule_injection_records || typeof state.rule_injection_records !== "object") {
    state.rule_injection_records = {};
  }
  state.rule_injection_records[ruleId] = {
    last_at: nowIso,
    last_file_tool_count: state.file_tool_count,
    last_event_signature: eventSignature,
  };
}

function selectAdvisoryRules(params) {
  const {
    allRules,
    contextTokens,
    contextSemanticTags,
    contextText,
    relativePath,
    failPatterns,
    state,
  } = params;
  const fullRules = [];
  const safetyRules = [];
  const seenRuleIds = new Set(state.injected_rule_ids ?? []);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  for (const r of allRules) {
    if (r.enforcement === "strict") continue;
    if (!isAdvisoryRuleRelevant(r, contextTokens, contextSemanticTags, contextText)) continue;

    const signature = ruleEventSignature(r, relativePath, contextText, failPatterns);
    const record = state.rule_injection_records?.[r.id] ?? null;

    // Backward compatibility for sessions created before rule_injection_records:
    // preserve the "already seen" decision and seed the lifecycle record.
    if (!record && seenRuleIds.has(r.id)) {
      markRuleInjected(state, r.id, signature, nowIso);
      continue;
    }

    if (!record || record.last_event_signature !== signature) {
      fullRules.push(r);
      markRuleInjected(state, r.id, signature, nowIso);
      continue;
    }

    if (safetyRules.length < SAFETY_RULE_LIMIT && shouldSafetyReinject(record, state, nowMs)) {
      safetyRules.push(r);
      markRuleInjected(state, r.id, signature, nowIso);
    }
  }

  return { fullRules, safetyRules };
}

// ─── Matcher helpers ──────────────────────────────────────────────────────────

function toRelative(absolutePath, workspaceRoot) {
  if (!absolutePath) return null;
  if (pathsEqual(absolutePath, workspaceRoot)) return "/";
  if (!pathStartsWith(absolutePath, workspaceRoot)) return null;
  // Slice by the original workspaceRoot length to preserve case in the
  // returned relative path. pathCompareKey is length-preserving.
  const prefix = /[\\/]$/.test(workspaceRoot) ? workspaceRoot : workspaceRoot + "/";
  return "/" + (process.platform === "win32" ? absolutePath.slice(prefix.length).replace(/\\/g, "/") : absolutePath.slice(prefix.length));
}

// Inline JS port of normalize_workspace_path() for the hook script.
// Cannot require the TS util; must be kept in sync with the TS twin at
// packages/protocol/src/normalize-workspace-path.ts.
// Input: a raw path string (absolute or relative, POSIX or Windows).
// Output: canonical workspace-relative POSIX string, or null if invalid.
function m43NormalizePath(rawPath, workspaceRoot) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return null;
  // 1) backslash → slash
  let p = rawPath.replace(/\\/g, "/");
  // 2) reject URL schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return null;
  // 3) strip Windows drive letter
  p = p.replace(/^[a-zA-Z]:\//, "/");
  // 4) reject parent traversal
  if (/(^|\/)\.\.($|\/)/.test(p)) return null;
  // 5) collapse // and remove ./ segments
  p = p.replace(/\/+/g, "/");
  let prev = "";
  while (prev !== p) {
    prev = p;
    p = p.replace(/(^|\/)\.(?=\/|$)/g, "$1");
  }
  p = p.replace(/\/+/g, "/");
  p = p.replace(/\/$/, "");
  // 6) strip workspace root prefix if present
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, "/").replace(/\/$/, "");
    const rootKey = IS_CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
    const pathKey = IS_CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
    if (pathKey === rootKey) return null;
    if (pathKey.startsWith(rootKey + "/")) {
      p = p.slice(root.length + 1);
    } else if (p.startsWith("/")) {
      // Check for sibling-repo (shared initial segments with workspace root)
      const rootParts = root.split("/").filter(Boolean);
      const pathParts = p.slice(1).split("/").filter(Boolean);
      let sharedLen = 0;
      for (let i = 0; i < Math.min(rootParts.length - 1, pathParts.length); i++) {
        const rk = IS_CASE_INSENSITIVE_FS ? rootParts[i].toLowerCase() : rootParts[i];
        const pk = IS_CASE_INSENSITIVE_FS ? pathParts[i].toLowerCase() : pathParts[i];
        if (rk === pk) sharedLen = i + 1;
        else break;
      }
      if (sharedLen > 0) return null; // outside workspace (sibling repo)
      p = p.slice(1); // workspace-absolute with spurious leading /
    }
  }
  // 7) strip remaining leading /
  p = p.replace(/^\/+/, "");
  if (p === "" || p === ".") return null;
  return p;
}

function ancestorPaths(startPath) {
  if (!startPath || startPath === "/") return ["/"];
  const parts = startPath.split("/").filter((p) => p.length > 0);
  const out = [];
  for (let i = parts.length; i > 0; i--) {
    out.push("/" + parts.slice(0, i).join("/"));
  }
  out.push("/");
  return out;
}

// Filename-scoped body preload helpers (mirror matcher.ts logic; inlined
// here because this JS file cannot require the TS module).
const FILENAME_PROMPT_RE =
  /\b[\w.-]+\.(json|ts|tsx|js|jsx|md|sql|ya?ml|toml|css|scss|html|py|rs|go|rb|php|sh)\b/gi;

function extractFilenameTokensFromPrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return [];
  const matches = prompt.match(FILENAME_PROMPT_RE);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

const SKILL_TOKEN_RE = /^[A-Za-z0-9_-]+/;
const SKILL_LEFT_BOUNDARY_RE = /[\s([{'"`]/;
// Reserved: `::pathrule:*` tokens are product directives (today the
// `::pathrule:package:<slug>` pattern import), NEVER skill invocations. This
// mirrors packages/protocol/src/skill-invocation.ts so the OFFLINE hook makes the
// exact same skill-vs-pattern distinction as the MCP get_context path. This file
// ships as raw JS to ~/.pathrule/bin (it can't import the TS module), so the two
// copies must be kept in sync.
const RESERVED_INVOCATION_PREFIX = "pathrule:";
const PATTERN_IMPORT_RE = /^pathrule:package:([a-z0-9][a-z0-9-]*)/i;

function normalizeSkillInvocationName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function extractSkillInvocationMarkers(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return [];
  const masked = maskMarkdownCode(prompt);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < masked.length - 2; i += 1) {
    if (masked[i] !== ":" || masked[i + 1] !== ":") continue;
    const prev = i === 0 ? "" : (masked[i - 1] ?? "");
    if (prev && !SKILL_LEFT_BOUNDARY_RE.test(prev)) continue;
    const rest = masked.slice(i + 2);
    // ::pathrule:* is a reserved product directive, not a skill — skip it so it
    // never reaches skill matching / the find-skills protocol.
    if (
      rest.slice(0, RESERVED_INVOCATION_PREFIX.length).toLowerCase() ===
      RESERVED_INVOCATION_PREFIX
    ) {
      i += 1 + RESERVED_INVOCATION_PREFIX.length;
      continue;
    }
    const match = rest.match(SKILL_TOKEN_RE);
    if (!match || !match[0]) continue;
    const name = normalizeSkillInvocationName(match[0]);
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ raw: match[0], name });
    }
    i += 1 + match[0].length;
  }
  return out;
}

/** Extract `::pathrule:package:<slug>` pattern-import directives (offline mirror
 *  of extractPatternImportMarkers in protocol/src/skill-invocation.ts). */
function extractPatternImportMarkers(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return [];
  const masked = maskMarkdownCode(prompt);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < masked.length - 2; i += 1) {
    if (masked[i] !== ":" || masked[i + 1] !== ":") continue;
    const prev = i === 0 ? "" : (masked[i - 1] ?? "");
    if (prev && !SKILL_LEFT_BOUNDARY_RE.test(prev)) continue;
    const match = masked.slice(i + 2).match(PATTERN_IMPORT_RE);
    if (!match || !match[1]) continue;
    const slug = match[1].toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push({ slug, raw: masked.slice(i, i + 2 + match[0].length) });
    }
    i += 1 + match[0].length;
  }
  return out;
}

function maskMarkdownCode(input) {
  let out = "";
  let i = 0;
  let inFence = false;
  let inInline = false;
  while (i < input.length) {
    if (input.startsWith("```", i)) {
      inFence = !inFence;
      out += "   ";
      i += 3;
      continue;
    }
    const ch = input[i] ?? "";
    if (!inFence && ch === "`") {
      inInline = !inInline;
      out += " ";
      i += 1;
      continue;
    }
    out += inFence || inInline ? (ch === "\n" ? "\n" : " ") : ch;
    i += 1;
  }
  return out;
}

function resolveInvokedSkills(prompt) {
  const markers = extractSkillInvocationMarkers(prompt);
  if (markers.length === 0) return null;

  const found = [];
  const missing = [];
  const duplicates = [];
  const skillIndex = index.skill_invocation_index ?? {};

  for (const marker of markers) {
    const matches = skillIndex[marker.name] ?? [];
    if (matches.length === 1) found.push(matches[0]);
    else if (matches.length > 1) duplicates.push(marker.name);
    else missing.push(marker.name);
  }

  return { found, missing, duplicates };
}

function truncateText(value, maxChars) {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

const HISTORY_EXPLICIT_RE = /\+\+history\b/i;
const HISTORY_DEEP_RE = /\+\+history\s+deep\b/i;
const HANDOFF_RE = /\+\+handoff\b/i;
const HISTORY_NATURAL_RE =
  /\b(previously|prior work|past work|history|how did we implement|how was .* implemented|update again)\b/i;
const HISTORY_NATURAL_TR_RE =
  /\b(daha once|daha önce|eskiden|gecmiste|geçmişte|once nasil|önce nasıl|nasil yapmistik|nasıl yapmıştık|nerede yapmistik|nerede yapmıştık)\b/i;

function stripHistoryMarkers(prompt) {
  return String(prompt ?? "")
    .replace(/\+\+history\b\s*(deep\b)?/gi, " ")
    .replace(/\+\+handoff\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function confidenceRank(value) {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function scoreWorkEpisode(queryTokens, episode) {
  if (!episode || typeof episode !== "object") return 0;
  if (queryTokens.size === 0) return 1;
  const text = [
    episode.title,
    episode.summary,
    Array.isArray(episode.subjects) ? episode.subjects.join(" ") : "",
    Array.isArray(episode.paths) ? episode.paths.join(" ") : "",
  ].join(" ");
  return keywordOverlap(queryTokens, text);
}

function resolvePriorWorkContext(prompt) {
  const raw = String(prompt ?? "");
  const explicit = HISTORY_EXPLICIT_RE.test(raw);
  const handoff = HANDOFF_RE.test(raw);
  const natural = HISTORY_NATURAL_RE.test(raw) || HISTORY_NATURAL_TR_RE.test(raw);
  if (handoff || (!explicit && !natural)) return null;

  const episodes = Array.isArray(index.work_episode_index) ? index.work_episode_index : [];
  if (episodes.length === 0) return null;

  const mode = HISTORY_DEEP_RE.test(raw) ? "deep" : "compact";
  const limit = mode === "deep" ? 3 : 2;
  const query = stripHistoryMarkers(raw) || raw;
  const queryTokens = tokenize(query);
  const scored = episodes
    .map((episode) => ({
      episode,
      score: scoreWorkEpisode(queryTokens, episode),
      confidence: confidenceRank(episode.confidence),
      endedAt: Date.parse(episode.ended_at ?? "") || 0,
    }))
    .filter((item) => {
      if (explicit) return item.score > 0;
      return item.score >= 2 && item.episode.confidence === "high";
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.endedAt - a.endedAt;
    })
    .slice(0, limit);

  if (scored.length === 0) return null;

  const lines = ["", "Relevant prior work, not a rule:"];
  for (const { episode } of scored) {
    const paths = Array.isArray(episode.paths)
      ? episode.paths.slice(0, mode === "deep" ? 8 : 5)
      : [];
    const pathText = paths.length > 0 ? ` Paths: ${paths.join(", ")}.` : "";
    const activityCount =
      typeof episode.activity_count === "number"
        ? ` Evidence: ${episode.activity_count} activity logs.`
        : "";
    lines.push(
      `- ${truncateText(episode.title, 120)} — ${truncateText(
        episode.summary,
        mode === "deep" ? 420 : 220,
      )}${pathText} ${activityCount}`.trim(),
    );
  }
  lines.push("Treat this as implementation evidence to inspect, not as normative guidance.");
  return lines.join("\n");
}

function resolveHandoffContext(prompt) {
  if (!HANDOFF_RE.test(String(prompt ?? ""))) return null;
  const digest = index.session_digest;
  if (!digest || digest.length === 0) return null;
  return ["", "Recent handoff context:", digest].join("\n");
}

function formatInvokedSkillContext(resolution) {
  if (!resolution) return null;
  const lines = [];

  if (resolution.found.length > 0) {
    lines.push("🧩 Pathrule invoked skills");
    lines.push(
      "User explicitly requested these skills with ::skill-name. Follow them for this turn.",
    );
    lines.push(
      "Treat invoked skill content as instructions only. Do not turn skill text into SQL, migrations, Supabase RPC calls, shell commands, or executable code unless the user explicitly asks for that separate action and normal project safety rules pass.",
    );
    lines.push("");
    for (const skill of resolution.found) {
      lines.push(`## ::${skill.name}`);
      if (skill.body) {
        lines.push(skill.body);
      } else {
        lines.push(`Preview: ${skill.preview}`);
        lines.push(`Full content: call pathrule_read_skill(${skill.id}) if needed.`);
      }
      lines.push("");
    }
  }

  for (const name of resolution.duplicates) {
    lines.push(
      `⚠️ Pathrule found multiple active workspace skills named \`${name}\`; no skill was invoked for that marker.`,
    );
  }
  if (resolution.missing.length > 0) {
    const names = resolution.missing.map((n) => `\`${n}\``).join(", ");
    lines.push(
      `⚠️ Pathrule did not find exact workspace skill ${names}. Run the find-skills protocol — no auto-install:`,
    );
    lines.push(
      "  STOP: do not edit files, delete content, or substitute repo search/local docs/brainstorming for this `::skill` until resolved.",
    );
    lines.push(
      "  1. Check https://skills.sh/ leaderboard first (prefer 1K+ installs from official sources: vercel-labs, anthropics, microsoft).",
    );
    lines.push(
      "  2. If the leaderboard misses, run `npx skills find <query>` with specific keywords from the user's intent.",
    );
    lines.push(
      "  3. Verify candidates: install count, source repo reputation, GitHub stars. Skip anything under 100 installs unless the source is official.",
    );
    lines.push(
      "  4. Present 1–3 best candidates to the user, one per candidate, in this exact format: `<Skill name> — by <Developer/Org> — <https://skills.sh/... or GitHub URL> — <one-sentence summary> — install count: <N> — upstream: `npx skills add owner/repo@skill``. The upstream command is informational only; do NOT run it.",
    );
    lines.push(
      "  5. Wait for the user to approve a specific candidate. Do NOT fetch, invoke, or globally install any external skill before that approval.",
    );
    lines.push(
      "  6. After approval, install into Pathrule (NOT globally via `-g`): pick the most specific `node_path` the skill belongs to (use the user's intent + workspace_overview; fall back to `/` only for genuinely workspace-wide skills), then call `pathrule_write_skill` with `source='github_ref'`, `github_url=<repo or skills.sh source URL>`, and the SKILL.md frontmatter + body inlined as `content`. Never run `npx skills add -g -y`.",
    );
  }

  const joined = lines.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Offline directive for `::pathrule:package:<slug>` tokens. The mirror of the MCP
 * get_context `pattern_import_instruction`: tells the agent this is a pattern
 * import (NOT a skill — no find-skills) and to call pathrule_import_pattern.
 */
function formatPatternImportContext(markers) {
  if (!markers || markers.length === 0) return null;
  const tokens = markers.map((m) => m.raw).join(", ");
  return [
    "🧩 Pathrule pattern import",
    `The user pasted a Pathrule pattern token (${tokens}). This is a pattern import, NOT a skill — do NOT run the find-skills protocol.`,
    'For each slug (the part after "package:"): (1) call pathrule_import_pattern(workspace_id, slug, dry_run:true) to see its appliesTo + pieces without writing; (2) pick the node_path base matching THIS workspace, and if the pattern\'s stack is not present here, ask the user whether and where to add it before writing; (3) call pathrule_import_pattern(workspace_id, slug, node_path) to import, then relay the human_message. Undo with pathrule_remove_pattern(workspace_id, slug, node_path).',
  ].join("\n");
}

function isAncestorPath(ancestor, descendant) {
  if (!ancestor || ancestor === "/" || ancestor === "") return true;
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith("/") ? ancestor : ancestor + "/";
  return descendant.startsWith(prefix);
}

function resolveFilenameInline(idx, tokens, cwdRelative) {
  const filenameIndex = idx.filename_index;
  if (!filenameIndex) return { action: "none" };

  const memoryById = new Map();
  const pathMems = idx.path_memories ?? {};
  for (const key of Object.keys(pathMems)) {
    for (const stub of pathMems[key]) memoryById.set(stub.id, stub);
  }

  const sortedTokens = [...tokens].sort();
  for (const token of sortedTokens) {
    const candidateIds = filenameIndex[token] ?? [];
    if (candidateIds.length === 0) continue;

    const scopedIds = candidateIds.filter((id) => {
      const mem = memoryById.get(id);
      if (!mem) return false;
      return isAncestorPath(mem.node_path, cwdRelative);
    });
    const effective = scopedIds.length > 0 ? scopedIds : candidateIds;

    if (effective.length > 1) {
      const candidates = effective
        .map((id) => memoryById.get(id))
        .filter(Boolean)
        .map((m) => ({ id: m.id, title: m.title }));
      if (candidates.length === 0) continue;
      return { action: "nudge", candidates };
    }

    const only = effective[0];
    if (!only) continue;
    const mem = memoryById.get(only);
    if (!mem) continue;
    if (!mem.body) {
      return { action: "nudge", candidates: [{ id: mem.id, title: mem.title }] };
    }
    return { action: "inline", memoryId: mem.id, title: mem.title, body: mem.body };
  }

  return { action: "none" };
}

// The full-body warehouse, keyed by item id, written next to hook-index.json
// by the writer. Read lazily and only on file tools, so the per-call matching path
// stays cheap. Returns {} when absent (delivery falls back to previews).
function loadWarehouse(wsId) {
  if (!wsId) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, wsId, "warehouse.json"), "utf8"));
  } catch {
    return {};
  }
}

// Precomputed knowledge embeddings (id→vector) written next to the
// warehouse. Read lazily + cached per process. {} when absent (no key/store) →
// the selector falls back to lexical ranking.
let embeddingsCacheWs = null;
let embeddingsCacheData = null;
function loadEmbeddings(wsId) {
  if (!wsId) return {};
  if (embeddingsCacheWs === wsId && embeddingsCacheData) return embeddingsCacheData;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, wsId, "embeddings.json"), "utf8"));
  } catch {
    data = {};
  }
  embeddingsCacheWs = wsId;
  embeddingsCacheData = data;
  return data;
}
// Bounded prompt embedding. Spawns the self-contained embed-query.cjs helper
// (next to this hook) with a tight timeout; on no-key/timeout/error returns a
// null vector + an outcome label so the caller can fall back to lexical ranking
// and record telemetry. Cached per prompt-hash within the process so an
// identical re-prompt never re-spawns. NEVER throws.
// Overridable so tests/keystones can inject a deterministic stub embedder
// (and a future warm daemon could repoint it) without a live Voyage call.
const EMBED_HELPER_PATH =
  process.env.PATHRULE_EMBED_HELPER && process.env.PATHRULE_EMBED_HELPER.trim() !== ""
    ? process.env.PATHRULE_EMBED_HELPER
    : path.join(__dirname, "embed-query.cjs");
const EMBED_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_EMBED_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 200), 5000) : 800;
})();
const promptVecCache = new Map();
function embedPromptVec(prompt) {
  const text = String(prompt ?? "").trim();
  if (text.length === 0) return { vec: null, candidates: null, outcome: "fallback_empty" };
  const key = crypto.createHash("sha256").update(`local\0${text}`).digest("hex").slice(0, 16);
  const cached = promptVecCache.get(key);
  if (cached) return cached;
  let result;
  try {
    const r = spawnSync(process.execPath, [EMBED_HELPER_PATH], {
      input: text,
      timeout: EMBED_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    if (r.error && r.error.code === "ETIMEDOUT") {
      result = { vec: null, candidates: null, outcome: "fallback_timeout" };
    } else if (r.status === 3) {
      result = { vec: null, candidates: null, outcome: "fallback_no_key" };
    } else if (r.status !== 0) {
      result = { vec: null, candidates: null, outcome: "fallback_error" };
    } else {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed.candidates)) {
        // A ranking service answered with candidates: the floor and any affinity weight were
        // applied there, so an EMPTY list is a real verdict ("nothing is relevant"), not a
        // failure. It is reported separately from an error so the two can never be confused.
        result = {
          vec: null,
          candidates: parsed.candidates,
          outcome: parsed.candidates.length > 0 ? "hit_cloud" : "cloud_below_threshold",
        };
      } else if (Array.isArray(parsed.embedding) && parsed.embedding.length > 0) {
        const floor = Number(parsed.min_similarity);
        const space = typeof parsed.space === "string" ? parsed.space : null;
        result = { vec: parsed.embedding, candidates: null, outcome: "hit", space, minSimilarity: floor > 0 && floor <= 1 ? floor : null };
      } else {
        result = { vec: null, candidates: null, outcome: "fallback_error" };
      }
    }
  } catch {
    result = { vec: null, candidates: null, outcome: "fallback_error" };
  }
  promptVecCache.set(key, result);
  return result;
}

// A local prompt vector meets only vectors of its own space (the index names embeddings.json's); any
// other pairing, a provider switch included, ranks by keywords. Equal dimensions prove nothing.
function withSameSpace(pv, idx) {
  if (!pv.vec || (pv.space ?? null) === (idx.embedding_space ?? null)) return pv;
  return { vec: null, candidates: null, outcome: "fallback_space_mismatch" };
}

// A stable hash of the normalized prompt. The body-block delta key folds
// this in so an identical prompt stays silent (cache) while a topic change on
// the SAME path re-selects.
function promptIntentHash(prompt) {
  const norm = String(prompt ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

function matchMemoriesForPath(idx, relativePath, limit) {
  const seen = new Set();
  const results = [];
  for (const ancestor of ancestorPaths(relativePath)) {
    const bucket = idx.path_memories?.[ancestor];
    if (!bucket) continue;
    for (const m of bucket) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      results.push(m);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

// Every rule whose SCOPE covers the path. Applicability is defined once, because
// enforcement and context both need the same answer and two walks would drift.
// Mirrors matcher.ts `collectApplicableRules`.
function collectApplicableRules(idx, relativePath) {
  const seen = new Set();
  const collected = [];
  for (const ancestor of ancestorPaths(relativePath)) {
    const bucket = idx.path_rules?.[ancestor];
    if (!bucket) continue;
    for (const r of bucket) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      collected.push(r);
    }
  }
  for (const r of idx.project_rules ?? []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    collected.push(r);
  }
  return collected;
}

// The advisory section header. MUST match ADVISORY_SECTION_HEADER in
// packages/agent-ir/src/delivery/agent-ir.ts: the lines are pre-rendered there and this file cannot
// require that TS module, so only the header is duplicated. Load-bearing text: it states advisories
// never override a rule, constraint, or security policy, which is how CONSTRAINT > REMEDY survives.
const ADVISORY_SECTION_HEADER =
  "💡 Pathrule advisories (approved corrective knowledge, advisory only; they never override a rule, a constraint, or a security policy):";

// Mirror of selectAdvisoriesForPath (agent-ir.ts): walk the path's ancestors collecting
// path_advisories, then project_advisories, dedupe by ref, drop what this session already got, cap at
// the budget. The index carries the pre-rendered advisory lines; the hook only selects by path and
// budgets. A stub with a `group` is one line of a memory's compiled form, which the completeness gate
// cleared as a WHOLE, so a group ships entirely or not at all; one that does not fit is skipped and
// the budget goes on to the next stub. A group the client's turn-zero file carries is not sent again.
function collectApplicableAdvisories(idx, relativePath, budget, skipRefs, turnZeroGroups, tokens) {
  const seen = new Set();
  const applicable = [];
  const cap = budget || 8;
  const push = (s, floor) => { // a set (a folder's or the project's) larger than one budget is delivered by relevance (2 shared words), not streamed whole
    if (!s || !s.ref || seen.has(s.ref) || (floor && tokens && keywordOverlap(tokens, s.line) < 2)) return;
    seen.add(s.ref);
    if (!(s.group && turnZeroGroups?.has(s.group)) && !skipRefs?.has(s.ref)) applicable.push(s);
  };
  for (const set of [...ancestorPaths(relativePath).map((a) => idx.path_advisories?.[a] ?? []), idx.project_advisories ?? []]) {
    for (const s of set) push(s, set.length > cap);
  }
  if (tokens) applicable.sort((a, b) => keywordOverlap(tokens, b.line) - keywordOverlap(tokens, a.line)); // the budget takes the most relevant first
  const out = [];
  const groupsSeen = new Set();
  for (const s of applicable) {
    if (out.length >= cap) break;
    if (!s.group) {
      out.push(s);
      continue;
    }
    if (groupsSeen.has(s.group)) continue;
    groupsSeen.add(s.group);
    const members = applicable.filter((x) => x.group === s.group);
    if (out.length + members.length <= cap) out.push(...members);
  }
  return out;
}

// Memories Claude holds as path-scoped rules (.claude/rules/pathrule/): those whose version the folder's
// manifest records is the one the index has. One written or changed since the last render is not held.
let instructionIdsMemo = null;
function instructionMemoryIds(idx) {
  if (instructionIdsMemo) return instructionIdsMemo;
  const want = clientShape === "claude" && typeof idx.workspace_root === "string" ? idx.instruction_memory_hashes : null;
  let held = {}, root = null; // only the root file loads at session start; an area file loads when a file under it is read
  try { if (want) { const m = JSON.parse(fs.readFileSync(path.join(idx.workspace_root, ".claude", "rules", "pathrule", "manifest.json"), "utf8")); held = m.memories ?? {}; root = Array.isArray(m.root) ? new Set(m.root) : null; } } catch {}
  return (instructionIdsMemo = new Set(Object.keys(want ?? {}).filter((id) => held[id] === want[id] && (!root || root.has(id)))));
}

// Memories a client's turn-zero files carry as their Agent IR group (a full client's file; Claude's rules folder, whose atom lines ARE the rule), never sent again.
function turnZeroCompiledGroups(idx) {
  const full = clientShape !== "claude" && idx.knowledge_compiled === true && Array.isArray(idx.compiled_memory_ids);
  return full ? new Set(idx.compiled_memory_ids) : instructionMemoryIds(idx);
}

// Record delivered advisory refs to a LOCAL, metadata-only ledger. `ref` is the atom fingerprint (a
// hash), never the knowledge text. `delivered` is the only event; used/succeeded/failed are a future
// seam, because delivery is not success. Best-effort: never block the agent.
function recordRemedyDeliveries(workspaceId, sessionId, relativePath, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return;
  try {
    const dir = path.join(CACHE_DIR, workspaceId);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = refs
      .map((ref) => JSON.stringify({ workspace_id: workspaceId, session_id: sessionId, atom_id: ref, path: relativePath ?? null, event: "delivered", created_at: ts }))
      .join("\n");
    fs.appendFileSync(path.join(dir, "remedy-deliveries.jsonl"), lines + "\n", { mode: 0o600 });
  } catch {
    // ignore: the delivery ledger is best-effort, never a reason to block a tool call.
  }
}

// Rules to SHOW: priority-sorted and cut to the context budget. The cut is the point.
function matchRulesForPath(idx, relativePath, limit) {
  const collected = collectApplicableRules(idx, relativePath);
  const rank = { high: 0, medium: 1, low: 2 };
  collected.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3));
  return collected.slice(0, limit);
}

// Rules to CHECK an Edit/Write against: unbudgeted, unsorted, strict-with-pattern only.
//
// Reading the deny check off the display list made enforcement a function of the
// context budget. Measured on rule 33: position 28 of 34 candidates against a limit of
// 12, and 19 of 25 project rules alone, so no path could reach the check at all. No
// limit here on purpose; a rule only enters this set by carrying a human-approved,
// active constraint that compiled. Mirrors matcher.ts `matchEnforcementRulesForPath`.
function matchEnforcementRulesForPath(idx, relativePath) {
  return collectApplicableRules(idx, relativePath).filter(
    (r) => r.enforcement === "strict" && (r.block_pattern != null || r.block_path != null),
  );
}

function pathMatchesGlob(p, glob) {
  if (!glob) return false;
  if (glob === p) return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
  }
  if (p === glob) return true;
  return p.startsWith(glob.endsWith("/") ? glob : glob + "/");
}

function matchFailPatterns(idx, relativePath, limit) {
  const out = [];
  for (const fp of idx.fail_patterns ?? []) {
    if (pathMatchesGlob(relativePath, fp.path_glob)) {
      out.push(fp);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function formatInjectionContext(params) {
  const {
    relativePath,
    memories,
    rules,
    safetyRules = [],
    semanticCandidates = [],
    failPatterns,
    advisories = [],
  } = params;
  if (
    memories.length === 0 &&
    rules.length === 0 &&
    safetyRules.length === 0 &&
    semanticCandidates.length === 0 &&
    failPatterns.length === 0 &&
    advisories.length === 0
  )
    return null;
  const lines = [];
  lines.push(`📌 Pathrule context for ${relativePath}:`);
  lines.push("");
  const strictRules = rules.filter((r) => r.enforcement === "strict");
  const advisoryRules = rules.filter((r) => r.enforcement !== "strict");
  // The id is printed next to every item so the agent can edit what it was just
  // shown without a lookup (pathrule_update_* takes the id; expected_version_id
  // is optional). `id ?? ""` guards stubs that predate the field.
  const idTag = (item) => (item && item.id ? ` (id: ${item.id})` : "");
  if (strictRules.length > 0) {
    lines.push("**🚨 Strict rules (violating these blocks your tool call):**");
    for (const r of strictRules) lines.push(`- **${r.name}**${idTag(r)} — ${r.preview}`);
    lines.push("");
  }
  if (advisoryRules.length > 0) {
    lines.push("**Rules in scope:**");
    for (const r of advisoryRules) lines.push(`- ${r.name} (${r.priority})${idTag(r)} — ${r.preview}`);
    lines.push("");
  }
  if (safetyRules.length > 0) {
    lines.push("**Pathrule still applies here:**");
    for (const r of safetyRules.slice(0, SAFETY_RULE_LIMIT)) lines.push(`- ${r.name}`);
    lines.push("");
  }
  if (memories.length > 0) {
    lines.push("**Memories scoped to this path:**");
    for (const m of memories) {
      // When the warehouse provided the full body, inject it whole so the
      // agent needs no follow-up read. Otherwise fall back to the preview.
      if (typeof m.__deltaBody === "string" && m.__deltaBody.length > 0) {
        lines.push(`### ${m.title}${idTag(m)}`);
        lines.push(m.__deltaBody);
        lines.push("");
      } else {
        lines.push(`- ${m.title}${idTag(m)} — ${m.preview}`);
      }
    }
    lines.push("");
  }
  if (semanticCandidates.length > 0) {
    lines.push("**Memories relevant to this work:**");
    for (const candidate of semanticCandidates) {
      // Inject the full body when the warehouse has it; else fall back to a
      // nudge (the agent reads it via pathrule_read_memory).
      if (typeof candidate.__deltaBody === "string" && candidate.__deltaBody.length > 0) {
        lines.push(`### ${candidate.title}${idTag(candidate)}`);
        lines.push(candidate.__deltaBody);
        lines.push("");
      } else {
        lines.push(
          `- ${candidate.title} (id: ${candidate.id}, ${candidate.confidence}, ${candidate.node_path}) — read the body before relying on it.`,
        );
      }
    }
    lines.push("");
  }
  if (failPatterns.length > 0) {
    lines.push("**⚠️ Recent failure patterns here:**");
    for (const fp of failPatterns) lines.push(`- ${fp.warning_text} (seen ${fp.count}×)`);
    lines.push("");
  }
  // Full-body delta delivery needs a larger ceiling than the preview path's
  // MAX_CONTEXT_CHARS (~1500). ~12000 chars ≈ 3000 tokens, matching the briefing
  // budget. Only applied when a full body is actually present.
  const hasFullBody =
    memories.some((m) => typeof m.__deltaBody === "string" && m.__deltaBody.length > 0) ||
    semanticCandidates.some(
      (c) => typeof c.__deltaBody === "string" && c.__deltaBody.length > 0,
    );
  // Rules are ALWAYS rendered preview-only here, so they count. Measured 2026-08-23 on a
  // real PreToolUse call that offered two rule names and no memories: hasPreviewOnly was
  // false, the read hint was omitted, and the agent was handed two names with no way to
  // fetch either. A name without a route is a dead end — the same defect the old
  // "(N more item(s) exceeded the inline budget)" line had.
  const hasPreviewOnly =
    rules.length > 0 ||
    safetyRules.length > 0 ||
    memories.some((m) => !(typeof m.__deltaBody === "string" && m.__deltaBody.length > 0)) ||
    semanticCandidates.some((c) => !(typeof c.__deltaBody === "string" && c.__deltaBody.length > 0));
  // Edit nudge: items are tagged with their id above, so an update needs no
  // lookup and no full-body resend — call update_* with the id + a content_edit
  // delta. Only tell the agent to re-read when a body was shown as a preview,
  // never for the full bodies already delivered here.
  const readHint = hasPreviewOnly
    ? "Need a full body shown above only as a preview? `pathrule_read_memory(id)` / `pathrule_read_rule(id)`. "
    : "";
  lines.push(
    `(${readHint}To EDIT an item above, call pathrule_update_memory / pathrule_update_rule with its (id) + a \`content_edit\` delta — no id lookup, no full-body resend. Fall back to files only after Pathrule has no match.)`,
  );
  // REMEDY advisories: a clearly subordinate section AFTER the rules/memories, so an agent never
  // reads advice with the authority of a rule. Lines are pre-rendered in the index (agent-ir.ts).
  if (advisories.length > 0) {
    lines.push("");
    lines.push(ADVISORY_SECTION_HEADER);
    for (const a of advisories) lines.push(a.line);
  }
  const cap = hasFullBody ? DELTA_MAX_CONTEXT_CHARS : MAX_CONTEXT_CHARS;
  let joined = lines.join("\n");
  if (joined.length > cap) joined = joined.slice(0, cap) + "…";
  return joined;
}
// ─── Event dispatch ──────────────────────────────────────────────────────────

// Open knowledge gaps (index.knowledge_gaps, written only when in-flow delivery is on).
// Inline twin of selectKnowledgeGap in knowledge-map/gap-delivery.ts; this file may not import.
const KNOWLEDGE_GAP_HEADER = "Pathrule knowledge gap (advisory; it never overrides a rule or constraint):";

function selectKnowledgeGapStub(idx, relativePath, delivered) {
  const stubs = Array.isArray(idx && idx.knowledge_gaps) ? idx.knowledge_gaps : [];
  const p = String(relativePath || "").replace(/^\/+/, "");
  for (const stub of stubs) {
    if (!stub || typeof stub.ref !== "string" || typeof stub.scope !== "string" || typeof stub.line !== "string") continue;
    if (delivered.has(stub.ref)) continue;
    if (p === stub.scope || p.startsWith(stub.scope + "/")) return stub;
  }
  return null;
}
// A changed decision held to the edit that writes the superseded value. Inline twin of
// selectChangedDecision in core/knowledge-map/changed-decisions.ts; this file may not import.
function selectChangedDecisionStub(idx, relativePath, newString, delivered) {
  const stubs = Array.isArray(idx && idx.changed_decisions) ? idx.changed_decisions : [];
  const p = String(relativePath || "").replace(/^\/+/, "");
  const text = String(newString || "").split("\n").filter((l) => !l.startsWith("-")).join("\n");
  for (const stub of stubs) {
    if (!stub || typeof stub.ref !== "string" || typeof stub.scope !== "string" || typeof stub.superseded !== "string" || typeof stub.line !== "string") continue;
    if (delivered.has(stub.ref) || (stub.scope && p !== stub.scope && !p.startsWith(stub.scope + "/"))) continue;
    if (text.includes(stub.superseded)) return stub;
  }
  return null;
}
// Runtime issues an application reported under this path (runtime-indicator.json, which the host
// writes after each ingest): counts only, never what the application sent. Inline twin of
// runtimeIndicatorLine in core/tools/runtime-events.ts; this file may not import. The most specific
// reported path the file sits in names the scope; issues under it are counted.
const RUNTIME_INDICATOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUNTIME_INDICATOR_PATH = /^[A-Za-z0-9._@+\-/]{1,200}$/;

function selectRuntimeIndicator(wsId, relativePath, delivered) {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, wsId, "runtime-indicator.json"), "utf8"));
  } catch {
    return null;
  }
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.paths)) return null;
  const at = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(at) || Date.now() - at > RUNTIME_INDICATOR_MAX_AGE_MS) return null;
  const entries = snapshot.paths.filter(
    (e) => e && typeof e.path === "string" && RUNTIME_INDICATOR_PATH.test(e.path),
  );
  const p = String(relativePath || "").replace(/^\/+/, "");
  let scope = null;
  for (const e of entries) {
    if ((p === e.path || p.startsWith(e.path + "/")) && (scope === null || e.path.length > scope.length)) {
      scope = e.path;
    }
  }
  if (scope === null) return null;
  let active = 0;
  let recurred = 0;
  const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
  for (const e of entries) {
    if (e.path === scope || e.path.startsWith(scope + "/")) {
      active += count(e.active);
      recurred += count(e.recurred);
    }
  }
  if (active <= 0) return null;
  const key = `${scope}:${active}:${recurred}`;
  if (delivered.has(key)) return null;
  const issues = active === 1 ? "1 active issue" : `${active} active issues`;
  const back = recurred > 0 ? ` (${recurred} came back after a fix)` : "";
  return { key, line: `Runtime: ${issues} under /${scope}${back}. Inspect with pathrule_runtime_events.` };
}

// Teammates' work state is the cloud extension's. It asks, and exits, when a teammate holds
// one of the paths, and returns true when nothing could complete the check: "degraded",
// which never interrupts a write, because not knowing whether a teammate holds a file is
// not grounds to stop the agent. Without the extension, or in a Local workspace, there is nothing
// to check.
async function checkWorkConflict(input) {
  if (isLocalWorkspace(workspaceId)) return false;
  const cloud = cloudExtension();
  return cloud ? cloud.askOnWorkConflict(input) : false;
}

async function handlePreToolUse() {
  const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  const filePath = typeof input.file_path === "string" ? input.file_path : null;

  const isFileTool = toolName === "Read" || toolName === "Edit" || toolName === "Write";
  const isWriteTool = toolName === "Edit" || toolName === "Write" || toolName === "Bash";
  if (!isFileTool || typeof filePath !== "string") {
    if (toolName === "Bash") {
      if (await checkWorkConflict(input)) {
        logLatency(eventName, toolName, "pass_work_conflict:degraded");
        emitEmpty();
      }
      logLatency(eventName, toolName, "noop_bash_no_conflict");
      emitEmpty();
    }
    logLatency(eventName, toolName, "noop_not_file_tool");
    emitEmpty();
  }

  const rel = toRelative(filePath, index.workspace_root);
  if (!rel) {
    logLatency(eventName, toolName, "path_outside_workspace");
    emitEmpty();
  }

  // Set when the teammate-conflict probe could not complete. It changes what we say
  // about conflicts, and NOTHING about whether the path's knowledge is delivered.
  //
  // DO NOT exit on it. This used to log the degraded pass and write "{}" with
  // process.exit(0) — so a probe that could not finish also silenced the
  // path-scoped KNOWLEDGE block assembled below. Measured 2026-08-23: 29 of 29
  // PreToolUse decisions came back `pass_work_conflict:degraded` (the supervisor probe
  // needs ~303 ms against an 80 ms cold-path budget), and the audit found 38 injections
  // across 1.818 firings — 5 memories in 8 days.
  const workConflictDegraded =
    isWriteTool && (await checkWorkConflict(input));

  // The conflict check is finished either way; log its outcome once, then carry on to
  // the knowledge block. Kept as its own log line so "the probe timed out" stays
  // distinguishable from "there was nothing to inject".
  if (workConflictDegraded) {
    logLatency(eventName, toolName, "pass_work_conflict:degraded");
  }

  const allMemories = matchMemoriesForPath(index, rel, 12);
  const allRules = matchRulesForPath(index, rel, 12);
  const failPatterns = matchFailPatterns(index, rel, 2);

  // Build keyword-context from the tool call's inputs (file path + new content).
  const newString = String(input.new_string ?? input.content ?? "");
  const contextTokens = new Set();
  for (const t of tokenize(rel)) contextTokens.add(t);
  for (const t of tokenize(newString.slice(0, 2000))) contextTokens.add(t);
  const contextSemanticTags = inferSemanticTags(
    semanticTextFromToolInput(newString).slice(0, 2000),
    "",
  );

  // ─── Strict rule block check ────────────────────────────────────────────
  // Fed by the UNBUDGETED enforcement set: `allRules` above is the display list and
  // is priority-sorted and truncated, which silently disarmed any strict rule that
  // lost the priority race.
  if (toolName === "Edit" || toolName === "Write") {
    for (const r of matchEnforcementRulesForPath(index, rel)) {
      // A path narrowing is an AND: a constraint scoped to a subtree does not apply
      // outside it, whatever the content says.
      if (r.block_path && !pathInConstraintScope(rel, r.block_path)) continue;
      let violated = false;
      let remedyCarrier = null;
      if (r.block_pattern) {
        let re;
        try {
          re = new RegExp(r.block_pattern.source, r.block_pattern.flags);
        } catch {
          continue;
        }
        violated = Boolean(newString) && re.test(newString);
        remedyCarrier = r.block_pattern;
      } else if (r.block_path) {
        // Path-only: the subject is WHERE the file is, so reaching here IS the violation
        // and there is no content to test.
        violated = true;
        remedyCarrier = r.block_path;
      }
      if (violated) {
        logLatency(eventName, toolName, `deny:${r.name}`);
        recordInjection({
          workspaceId,
          sessionId,
          toolName: "PreToolUse",
          filePath: rel,
          ruleCount: 1,
          memoryCount: 0,
          decision: "deny",
          ruleIds: [r.id],
          memoryIds: [],
          skillIds: [],
        });
        // The authored remedy, when the constraint carries one. A deny that only says
        // "blocked" leaves the agent with nothing to do differently, so the message the
        // human wrote at approval time is the part that has to travel.
        const remedy = remedyCarrier && remedyCarrier.message
          ? `\n\nDo this instead: ${remedyCarrier.message}`
          : "";
        emit({
          decision: "deny",
          reason: `🚨 Pathrule blocked: "${r.name}"\n\n${r.preview}${remedy}\n\n${r.block_pattern ? "Your edit matches this rule's forbidden pattern." : "This rule forbids writing that file at that path."} Read the full rule via pathrule_read_rule(${r.id}) and retry without the violation.`,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Violates strict rule: ${r.name}`,
          },
        });
      }
    }
  }

  // ─── Lifecycle-gated advisory injection ─────────────────────────────────
  // Strict rules are enforced above, not injected as advisory context on every
  // clean call. Advisory rules inject on first relevance, new lifecycle
  // signature, or a title-only long-session safety net.
  const state = readSessionState();
  state.file_tool_count = (state.file_tool_count ?? 0) + 1;
  // Session recency: remember the paths this session touches (most
  // recent first, capped) so the next prompt's route can prefer the live work area.
  state.session_paths = [rel, ...(state.session_paths ?? []).filter((p) => p !== rel)].slice(0, 10);

  // ─── CHECK: mark the required verification pending ──────────────────────
  // Mutating THIS state object rather than doing its own read/write pair. The first
  // version of this did the pair and the write below silently clobbered it: two
  // independent reads of one ledger in one invocation, and the later write wins.
  //
  // A mutation inside a compiled check's scope makes its verification owed again even
  // if it passed earlier in the session, because a suite that passed before this edit
  // says nothing about the code after it. Nothing is blocked here; Stop does that.
  if (toolName === "Edit" || toolName === "Write") {
    try {
      const pending = Array.isArray(state.pending_checks) ? state.pending_checks : [];
      for (const r of matchCheckRulesForPath(index, rel)) {
        const rc = r.required_check;
        if (!rc || !rc.fingerprint || !pathInCheckScope(rel, rc.scope_path)) continue;
        state.satisfied_checks = (state.satisfied_checks ?? []).filter(x => !x || x.rule_id !== r.id);
        if (pending.some((x) => x && x.rule_id === r.id && x.command === rc.command)) continue;
        pending.push({
          rule_id: r.id,
          rule_name: r.name,
          fingerprint: rc.fingerprint,
          command: rc.command,
          message: rc.message,
          since: new Date().toISOString(),
        });
      }
      if (pending.length > 0) {
        state.pending_checks = pending;
        logLatency(eventName, toolName, "check_pending:" + pending.length);
      }
    } catch {
      // A ledger failure must never block an edit.
    }
  }
  // Route follow-through (did this file tool reach a path the last route named) is the
  // cloud extension's route telemetry.
  cloudExtension()?.noteRouteFollow(state, rel);
  const seenMemoryIds = new Set(state.injected_memory_ids);
  const contextText = `${rel} ${newString.slice(0, 2000)}`;

  const { fullRules: filteredRules, safetyRules } = selectAdvisoryRules({
    allRules,
    contextTokens,
    contextSemanticTags,
    contextText,
    relativePath: rel,
    failPatterns,
    state,
  });

  // Memories: hash-aware delta dedup + loose keyword relevance.
  // Skip a memory only when it was already injected this session AND its body is
  // unchanged (content_hash match). An edited memory re-injects; an unchanged one
  // stays silent. Falls back to id-only dedup if the index has no content_hash.
  //
  // Native Knowledge Compilation: memories already delivered via compiled
  // turn-zero files (knowledge_compiled) never re-inject here — the agent has
  // them in context from the directory's native instruction file.
  const injectedHashes = state.injected_memory_hashes ?? {};
  const compiledMemoryIds = new Set(
    index.knowledge_compiled === true && Array.isArray(index.compiled_memory_ids)
      ? index.compiled_memory_ids
      : [],
  );
  const filteredMemoryCandidates = [];
  let memoryIndex = 0;
  for (const m of allMemories) {
    const currentIndex = memoryIndex++;
    if (compiledMemoryIds.has(m.id)) continue;
    const seenUnchanged = m.content_hash
      ? injectedHashes[m.id] === m.content_hash
      : seenMemoryIds.has(m.id);
    if (seenUnchanged) continue;
    const score = memoryRelevanceScore(contextTokens, `${m.title} ${m.preview}`);
    const tagPart = semanticTagScore(contextSemanticTags, m.semantic_tags);
    // Path relation WEIGHTS the match, it does not gate it: a lone token from an ancestor ranks below
    // the same token on the exact node, but admission stays on the score alone. Gating on score × tier
    // once dropped a genuine match ("Translation file workflow" on its own i18n file, one shared token);
    // the off-topic items that motivated tiering were rules, which have their own gate now.
    const tier = pathRelationTier(m.node_path, rel);
    if (score < memoryThreshold(m, 1) && !(score >= 1 && tagPart.score >= 4)) continue;
    filteredMemoryCandidates.push({
      memory: m,
      score: (score * 3 + tagPart.score) * tier,
      depth: pathDepth(m.node_path),
      index: currentIndex,
    });
  }
  filteredMemoryCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.index - b.index;
  });
  const filteredMemories = filteredMemoryCandidates.map((item) => item.memory).slice(0, 3);
  // PreToolUse is the NAME channel, not the body channel: it runs on EVERY Read/Edit/Write, and one body
  // lifts the cap from 1.500 to 12.000 chars (measured 2026-08-23: 12.000 on 5 of 5 files, and the dedup
  // did not converge on the same file). A name, an id and one line say which constraints and memories
  // exist on the path; the agent pulls a body it decides it needs. Bodies ship once per prompt from
  // buildNavigationBodyBlock, where the relevance bar and the budget apply.
  const semanticCandidates =
    filteredMemories.length === 0
      ? selectSemanticMemoryCandidates({
          index,
          contextTokens,
          contextSemanticTags,
          injectedHashes,
          // The file being touched. Without it every tier collapses to "elsewhere"
          // and the path signal is inert.
          relativePath: rel,
          seenMemoryIds: new Set(state.semantic_candidate_ids ?? []),
          excludeMemoryIds: new Set([
            ...filteredMemories.map((memory) => memory.id),
            ...Array.from(seenMemoryIds),
            ...Array.from(compiledMemoryIds),
            ...instructionMemoryIds(index),
          ]),
          // Names only, on every file tool call: three, and two shared words on the node (or one
          // plus a tag), or "applications.py" offered every section titled "bigger-applications"
          // (measured 2026-10-15 on fastapi: ~13k chars a session of unrelated names).
          limit: 2,
          minScore: 6,
        })
      : [];
  // Same reasoning as the path memories above: no bodies on this channel. The stub
  // render already prints "(id: …, confidence, node_path) — read the body before
  // relying on it", which is the whole contract — an offer the agent can take up.
  //
  // Keeping the cap at MAX_CONTEXT_CHARS is the point: with no body attached,
  // formatInjectionContext's `hasFullBody` stays false and the block is bounded at
  // 1.500 chars (~375 tokens) per tool call instead of 12.000 (~3.000).

  // REMEDY advisories that apply to this path, deduped per session so an approved remedy injects
  // once and does not repeat on every tool call. Bounded by the same 8-item budget as the IR layer.
  const deliveredAdvisoryRefs = new Set(state.delivered_advisory_refs ?? []);
  const newAdvisories = collectApplicableAdvisories(index, rel, 8, deliveredAdvisoryRefs, turnZeroCompiledGroups(index), tokenize(rel + " " + String(input.new_string ?? input.content ?? "").slice(0, 2000)));

  const knowledgeContext = formatInjectionContext({
    relativePath: rel,
    memories: filteredMemories,
    rules: filteredRules,
    safetyRules,
    semanticCandidates,
    failPatterns,
    advisories: newAdvisories,
  });

  // An open knowledge gap reaches only the agent WRITING inside it, once per session per
  // gap, as one line after the knowledge block. Never on a read. No stubs, no change.
  const deliveredGapRefs = new Set(state.delivered_gap_refs ?? []);
  const gapStub =
    toolName === "Edit" || toolName === "Write" ? selectKnowledgeGapStub(index, rel, deliveredGapRefs) : null;
  // A value a later decision superseded, written again: one line, once per session per decision,
  // on the same ledger as the gaps.
  const supersededStub = toolName === "Edit" || toolName === "Write" ? selectChangedDecisionStub(index, rel, newString, deliveredGapRefs) : null;
  const extraLines = [gapStub ? `${KNOWLEDGE_GAP_HEADER}\n${gapStub.line}` : "", supersededStub ? supersededStub.line : ""].filter(Boolean);
  const withGap = extraLines.length > 0 ? `${knowledgeContext ? `${knowledgeContext}\n\n` : ""}${extraLines.join("\n\n")}` : knowledgeContext;
  if (gapStub || supersededStub) state.delivered_gap_refs = [...deliveredGapRefs, ...[gapStub, supersededStub].filter(Boolean).map((x) => x.ref)];
  // The application's runtime issues where the agent is writing, once per session while the counts
  // stay the same. Never on a read.
  const deliveredRuntimeKeys = new Set(state.delivered_runtime_keys ?? []);
  const runtimeIndicator =
    toolName === "Edit" || toolName === "Write"
      ? selectRuntimeIndicator(workspaceId, rel, deliveredRuntimeKeys)
      : null;
  const context = runtimeIndicator
    ? `${withGap ? `${withGap}\n\n` : ""}${runtimeIndicator.line}`
    : withGap;
  if (runtimeIndicator) {
    state.delivered_runtime_keys = [...deliveredRuntimeKeys, runtimeIndicator.key].slice(-50);
  }

  if (!context) {
    writeSessionState(state);
    logLatency(eventName, toolName, "deduped_no_new");
    emitEmpty();
  }

  // Record delivery ONLY when the context is actually emitted. `delivered` is not `used` and not
  // `succeeded`: the ledger records that the agent SAW the advisory, nothing more.
  if (context && newAdvisories.length > 0) {
    state.delivered_advisory_refs = [...deliveredAdvisoryRefs, ...newAdvisories.map((a) => a.ref)];
    recordRemedyDeliveries(workspaceId, sessionId, rel, newAdvisories.map((a) => a.ref));
  }

  if (!state.injected_memory_hashes) state.injected_memory_hashes = {};
  for (const m of filteredMemories) {
    if (!seenMemoryIds.has(m.id)) state.injected_memory_ids.push(m.id);
    // Record the injected body hash so an unchanged memory stays silent and
    // an edited one (new hash) re-injects on its next relevance.
    if (m.content_hash) state.injected_memory_hashes[m.id] = m.content_hash;
  }
  if (semanticCandidates.length > 0) {
    state.semantic_candidate_ids = Array.from(
      new Set([...(state.semantic_candidate_ids ?? []), ...semanticCandidates.map((c) => c.id)]),
    );
    // Record injected body hashes so an unchanged candidate stays silent
    // next turn (no rotation) and an edited one re-surfaces.
    for (const c of semanticCandidates) {
      if (c.content_hash) state.injected_memory_hashes[c.id] = c.content_hash;
    }
  }
  writeSessionState(state);

  logLatency(
    eventName,
    toolName,
    `inject(${filteredMemories.length}m/${semanticCandidates.length}s/${filteredRules.length + safetyRules.length}r/${failPatterns.length}f, of ${allMemories.length}m/${allRules.length}r available)`,
  );
  // Apply injection strategy filter to filteredRules (advisory).
  // safetyRules (strict) bypass the filter — they are always injected.
  const m44RuleResult = m44SelectInjectedRules(
    sessionId || "default",
    filteredRules,
    M44_PROMOTION_ENABLED,
  );
  const finalRules = m44RuleResult.injected;

  recordInjection({
    workspaceId,
    sessionId,
    toolName: "PreToolUse",
    filePath: rel,
    ruleCount: finalRules.length + safetyRules.length,
    memoryCount: filteredMemories.length + semanticCandidates.length,
    decision: null,
    ruleIds: [...finalRules, ...safetyRules].map((r) => r.id).filter(Boolean),
    memoryIds: [
      ...filteredMemories.map((m) => m.id),
      ...semanticCandidates.map((m) => m.id),
    ].filter(Boolean),
    skillIds: [],
    injectionStrategyBreakdown: m44RuleResult.breakdown,
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  });
}

// Wording lives with the User Intelligence layer (user-delivery.ts exports the same string); duplicated here only because this file may not import anything.
const USER_PREFERENCE_HEADING = "## How this user prefers to work\nFollow these unless a rule, a required verification or a safety boundary says otherwise: those always win.";

function handleUserPromptSubmit() {
  // Digest is session-lifetime (first prompt only).
  // Metadata + project_rules refresh every USER_PROMPT_REFRESH_EVERY'th
  // prompt instead of every prompt. Panel stats previously counted each
  // repeat as an "injection" even though the agent had already seen the
  // content; the throttle keeps long sessions honest.
  const state = sessionFile ? readSessionState() : null;
  const userPrompt = typeof event.prompt === "string" ? event.prompt : "";
  if (userPrompt.trim() && workspaceId) try { fs.appendFileSync(path.join(CACHE_DIR, workspaceId, "user-words.jsonl"), JSON.stringify({ sid: sessionId, at: new Date().toISOString(), text: userPrompt.slice(0, 4000) }) + "\n", { mode: 0o600 }); } catch { /* grounding for pathrule_remember_preference only; never blocks */ }
  const nextPromptCount = (state?.user_prompt_count ?? 0) + 1;
  const shouldInjectMeta = (nextPromptCount - 1) % USER_PROMPT_REFRESH_EVERY === 0;
  const shouldInjectDigest = !state || state.digest_injected !== true;
  // The agent protocol, when the workspace delivers it through the hook instead
  // of the companion files. One source of truth: the text is rendered into the
  // hook index by the same code that used to render it to disk, so the two can
  // never drift. No `index.protocol` → nothing here changes.
  const sessionProtocol = sessionProtocolText();
  const shouldInjectProtocol = !!sessionProtocol && (!state || state.protocol_injected !== true);
  // Team and personal profiles the session start did not deliver: a session whose SessionStart never
  // reached us, or a block whose version changed since (an account sync rewrote the index). Cursor and
  // Copilot never get here (their prompt event carries no context; see the dispatch below), so a
  // version is only recorded where it was actually delivered.
  const sessionProfiles = deliverableProfiles(index);
  const shouldInjectProfiles =
    !!sessionProfiles && (!state || state.delivered_profile_version !== sessionProfiles.version);
  // Whether this session is consuming context fast (a fixed "no" today). Read once per
  // prompt, before anything spends: a reader that records the transcript size would
  // corrupt its growth history if called twice.
  const contextPressure = deliveryDecisions.readContextPressure(state);
  const framingLength =
    (shouldInjectProtocol && sessionProtocol ? sessionProtocol.length + 2 : 0) +
    (shouldInjectProfiles ? sessionProfiles.block.length + 2 : 0);
  promptBodyCap = PROVIDER_CONTEXT_LIMIT
    ? Math.max(1500, PROVIDER_CONTEXT_LIMIT - framingLength - PROVIDER_FRAME_RESERVE)
    : Infinity;

  // Persist the incremented counter regardless of whether we inject, so the
  // rhythm (1, 13, 25, …) stays stable across prompts.
  if (state) {
    state.user_prompt_count = nextPromptCount;
    if (shouldInjectDigest) state.digest_injected = true;
    if (shouldInjectProtocol) state.protocol_injected = true;
    if (shouldInjectProfiles) state.delivered_profile_version = sessionProfiles.version;
    // Pulls are credited BEFORE anything ranks this prompt, so a memory the agent pulled
    // last turn would already be boosted for this one (nothing is credited today). Draining
    // afterwards would make the signal a turn late.
    const creditedPulls = deliveryDecisions.applyKnowledgePulls(workspaceId, state);
    if (creditedPulls > 0) {
      cloudExtension()?.logNavigation(workspaceId, {
        t: "pull_credited",
        session_id: sessionId,
        paths: [],
        count: creditedPulls,
      });
    }
    writeSessionState(state);
  }

  // Compute filename-scoped inline BEFORE the throttle check, so it
  // runs on every prompt regardless of meta/digest refresh rhythm.
  let filenameInlineBlock = null;
  try {
    const tokens = extractFilenameTokensFromPrompt(userPrompt);
    if (tokens.length > 0 && index.filename_index) {
      const cwdRelative = toRelative(cwd, index.workspace_root) ?? "/";
      const resolution = resolveFilenameInline(index, tokens, cwdRelative);
      if (resolution.action === "inline") {
        const alreadyInjected =
          state &&
          Array.isArray(state.injected_memory_ids) &&
          state.injected_memory_ids.includes(resolution.memoryId);
        if (!alreadyInjected) {
          const block = [
            "",
            `📌 Filename match — full body for "${resolution.title}":`,
            "",
            resolution.body,
            "",
            `(Memory id: ${resolution.memoryId})`,
          ].join("\n");
          filenameInlineBlock = { text: block, memoryId: resolution.memoryId };
          if (state) {
            state.injected_memory_ids = Array.from(
              new Set([...(state.injected_memory_ids ?? []), resolution.memoryId]),
            );
            writeSessionState(state);
          }
        }
      } else if (resolution.action === "nudge") {
        const block = [
          "",
          "🔒 Multiple filename matches — call pathrule_read_memory(id) for the right one:",
          ...resolution.candidates.map((c) => `- ${c.title} (id: ${c.id})`),
        ].join("\n");
        filenameInlineBlock = { text: block, memoryId: null };
      }
    }
  } catch {
    // Best-effort — never block the prompt on filename-inline errors.
  }

  const skillResolution = resolveInvokedSkills(userPrompt);
  const invokedSkillBlock = formatInvokedSkillContext(skillResolution);
  const patternImportBlock = formatPatternImportContext(extractPatternImportMarkers(userPrompt));
  const priorWorkBlock = resolvePriorWorkContext(userPrompt);
  const handoffBlock = resolveHandoffContext(userPrompt);
  const rawProjectRules = state ? selectPromptProjectRules(index, userPrompt, state) : [];
  // Apply injection strategy filter to project rules.
  const m44PromptRuleResult = m44SelectInjectedRules(
    sessionId || "default",
    rawProjectRules,
    M44_PROMOTION_ENABLED,
  );
  const projectRules = m44PromptRuleResult.injected;
  const refreshLine = shouldMentionRefreshTasks(userPrompt)
    ? formatPendingRefreshLine(index)
    : null;
  // On slim router clients (Claude) the navigation body block IS the
  // relevance channel: it delivers prompt-ranked full BODIES (Voyage top-k),
  // delta-silent. The legacy lexical candidate block only injects TITLE pointers
  // (which the agent can't resolve without MCP) and re-fires on repeats (breaking
  // cache-stability), so it is suppressed here — bodies via the body block win.
  const slimClient = clientShape === "claude";
  // Navigation Engine v1 — the likely target paths for this prompt, computed ONCE and read by
  // both consumers: the semantic candidates below tier against it, the navigation block emits
  // it. Declared inside that block, it left the candidate read pointing at nothing, so every
  // non-Claude discovery prompt threw a ReferenceError and the hook exited 1 with no context.
  // The gate is the navigation block's own: navigation off, no session state or a prompt too
  // short to route means there is no route, and the candidates are told exactly that.
  const routeEligible = NAVIGATION_MODE !== "off" && !!state && userPrompt.trim().length >= 15;
  const route = routeEligible
    ? selectNavigationRoute(index, tokenize(userPrompt), userPrompt, state.session_paths ?? [])
    : [];
  const promptSemanticCandidates =
    state && !slimClient && shouldInjectSemanticPromptCandidates(userPrompt)
      ? selectSemanticMemoryCandidates({
          index,
          contextTokens: tokenize(userPrompt),
          contextSemanticTags: inferSemanticTags(userPrompt, cwd),
          // A prompt has no single file, so the routed path stands in for it. When the
          // router produced nothing, tiering would be guesswork: passing undefined
          // makes every candidate "elsewhere", which correctly RAISES the bar rather
          // than inventing a path relation that was never established.
          relativePath: route.length > 0 ? route[0].path : undefined,
          seenMemoryIds: new Set(state.semantic_candidate_ids ?? []),
          // Native Knowledge Compilation: compiled memories already sit in the
          // agent's turn-zero files — never re-surface them as candidates.
          excludeMemoryIds: new Set([
            ...(state.injected_memory_ids ?? []),
            ...(index.knowledge_compiled === true && Array.isArray(index.compiled_memory_ids)
              ? index.compiled_memory_ids
              : []),
          ]),
          limit: 3,
        })
      : [];

  // Navigation Engine v1 — emit the route computed above once per distinct route
  // (delta: an unchanged route stays silent, so repeated prompts on the same topic
  // don't grow the context).
  let navigationBlock = null;
  let navigationBodyBlock = null;
  if (routeEligible) {
    // The agent is WORKING in cwd; that path's knowledge is relevant to the
    // prompt whether or not the knowledge-free lexical router fired. The route
    // POINTER stays gated on the lexical route, but the BODY block also
    // targets the cwd path when it carries knowledge — so a prompt whose words
    // don't lexically hit the route ("database layer" vs a /src db memory) still
    // gets that path's prompt-ranked top-k bodies. The Voyage top-k inside
    // buildNavigationBodyBlock then picks the relevant items.
    const cwdRel = toRelative(cwd, index.workspace_root) ?? "/";
    const slimClient = clientShape === "claude";
    // The route POINTER stays gated on the lexical route (cache-stable).
    const bodyRoute = route.length > 0 ? route : [{ path: cwdRel, why: "working here" }];

    if (route.length > 0) {
      const signature = navigationRouteSignature(route);
      if (state.last_route_signature !== signature) {
        const delivered = NAVIGATION_MODE !== "suppressed";
        if (delivered) navigationBlock = formatNavigationRoute(route, index, state);
        state.last_route_signature = signature;
        state.last_route_paths = route.map((r) => r.path);
        state.route_followed_logged = false;
        cloudExtension()?.logNavigation(workspaceId, {
          t: "emitted",
          session_id: sessionId,
          paths: state.last_route_paths,
          // The eligibility record. A route that was computed but withheld is the
          // control arm of the routing experiment, and it must be distinguishable from
          // "no route was available here": those two have opposite readings.
          delivered,
        });
      }
    }
    // BODY delivery is now GLOBAL semantic for slim clients: it runs on any
    // prompt where the workspace has knowledge (route-independent), and
    // buildNavigationBodyBlock ranks the whole KB by prompt cosine → no lexical
    // routing miss. Delta key = the prompt-intent hash (global), so an identical
    // prompt stays silent and a new topic re-selects. Full clients keep the
    // route-scoped body (gated on having a route/cwd path).
    // Rules count as knowledge. They did not, and the consequence is a workspace holding
    // only rules — no memories, no skills — never receiving a body block at all: the gate
    // closed before the rule assembly could run. Rules are the one kind that is
    // unconditional, so gating them on the presence of a DIFFERENT kind was backwards.
    const hasKnowledge =
      Object.keys(index.path_memories ?? {}).length > 0 ||
      Object.keys(index.path_skills ?? {}).length > 0 ||
      Object.keys(index.path_rules ?? {}).length > 0 ||
      (Array.isArray(index.project_rules) && index.project_rules.length > 0);
    const runBody = slimClient ? hasKnowledge : route.length > 0;
    if (runBody) {
      const intentSig = slimClient
        ? `g::${promptIntentHash(userPrompt)}`
        : `${bodyRoute.map((r) => r.path).join(",")}::${promptIntentHash(userPrompt)}`;
      if (state.last_body_intent_sig !== intentSig) {
        navigationBodyBlock = buildNavigationBodyBlock(
          bodyRoute,
          index,
          state,
          userPrompt,
          contextPressure,
        );
        state.last_body_intent_sig = intentSig;
        if (navigationBodyBlock) {
          cloudExtension()?.logNavigation(workspaceId, {
            t: "body_injected",
            session_id: sessionId,
            paths: slimClient ? ["*global*"] : bodyRoute.map((r) => r.path),
            select: lastBodySelectOutcome,
            // Separate dimension from `select` on purpose: `select` says which
            // CHANNEL ranked (cloud / local vector / keyword overlap) and `floor`
            // says whether the keyword gate could act. Folded into one string they
            // would stop being answerable questions.
            floor: lastLexicalFloor,
          });
        } else {
          // Selection ran and delivered nothing. Without this line the relevance
          // gate would be unobservable: a suppressed prompt looks identical to a
          // prompt where the hook was never asked, and "the gate is working" would
          // be indistinguishable from "the gate broke everything".
          cloudExtension()?.logNavigation(workspaceId, {
            t: "body_suppressed",
            session_id: sessionId,
            paths: slimClient ? ["*global*"] : bodyRoute.map((r) => r.path),
            select: lastBodySelectOutcome,
            floor: lastLexicalFloor,
          });
        }
      }
    }
    writeSessionState(state);
  }

  // Compiled Agent IR advisories (REMEDY / SELECTION / PROCEDURE / CONTEXT / RATIONALE) for the working
  // path, delivered UP FRONT on the prompt so the agent has the approved corrective knowledge before it
  // acts, not only later on a PreToolUse for a matching file. Same selection + delta contract as the
  // PreToolUse path: scope to the cwd's ancestors + project, cap at the IR budget (8), and gate by ref
  // through the shared delivered_advisory_refs ledger so each advisory injects ONCE per session (a
  // repeat prompt stays cache-stable, and the PreToolUse path will not re-deliver what shipped here).
  // PRECEDENCE is already resolved backend-side (losing atoms are withheld before they reach the index),
  // so what is here is the deliverable, conflict-resolved set. Lines are pre-rendered in the index
  // (assembleHookIndex -> renderAdvisoryLine/renderSelectionLine/…), so the hook only selects + budgets.
  let advisoryBlock = null;
  let freshAdvisoryRefs = [];
  {
    const cwdRel = toRelative(cwd, index.workspace_root) ?? "/";
    const deliveredRefs = new Set(state?.delivered_advisory_refs ?? []);
    const fresh = collectApplicableAdvisories(index, cwdRel, 8, deliveredRefs, turnZeroCompiledGroups(index), tokenize(userPrompt));
    if (fresh.length > 0) {
      advisoryBlock = [ADVISORY_SECTION_HEADER, ...fresh.map((a) => a.line)].join("\n");
      freshAdvisoryRefs = fresh.map((a) => a.ref);
    }
  }

  // User Intelligence: how THIS PERSON works, compiled upstream; this only matches the index's entries against
  // the prompt and skips what this session already got. Matched BEFORE the nothing-new exit below: a preference
  // or oversight note this prompt is about IS something to say, and the exit used to drop it silently.
  const personalDeliverable = index.personal_owner == null || ownerSignedIn(index.personal_owner);
  const userPrefEntries = personalDeliverable && Array.isArray(index.user_preferences) ? index.user_preferences : [];
  const guidanceEntries = personalDeliverable && Array.isArray(index.guidance) ? index.guidance : [];
  const userPrefLines = [];
  const freshUserPrefIds = [];
  const guidanceLines = [];
  if (userPrefEntries.length > 0 || guidanceEntries.length > 0) {
    const deliveredPrefs = new Set((state && state.delivered_user_pref_ids) || []);
    // Same folding, matching and risk rules as user-intelligence/{text-fold,user-delivery,risk-gate}.ts.
    const words = String(userPrompt || "").toLowerCase().replace(/[\u0131\u0142\u00f8\u0111\u00f0\u0127\u0167\u00df\u00e6\u0153\u00fe]/g, (c) => ({ "\u0131": "i", "\u0142": "l", "\u00f8": "o", "\u0111": "d", "\u00f0": "d", "\u0127": "h", "\u0167": "t", "\u00df": "ss", "\u00e6": "ae", "\u0153": "oe", "\u00fe": "th" })[c] || c).normalize("NFD")
      .replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
    const hit = (t) => words.some((w) => w.length >= 3 && (w === t || (t.length >= 4 && w.startsWith(t)) || (w.length >= 5 && t.startsWith(w)) || ((n) => n >= 6 && n >= Math.ceil(0.8 * Math.min(t.length, w.length)))(t.split("").findIndex((c, i) => c !== w[i]) === -1 ? Math.min(t.length, w.length) : t.split("").findIndex((c, i) => c !== w[i]))));
    const riskHit = (t) => typeof t === "string" && words.some((w) => w === t || (t.length >= 5 && w.startsWith(t)));
    const risk = Array.isArray(index.user_preference_risk_terms) ? index.user_preference_risk_terms : [];
    const highRisk = risk.some(riskHit);
    const matches = (entry) => {
      if ((entry.relaxes === true && highRisk) || (typeof entry.path === "string" && !ancestorPaths(toRelative(cwd, index.workspace_root) ?? "/").includes(entry.path))) return false; // risky work keeps its bar; a narrowed belief stays under its path
      if (entry.always) return true;
      // A composed claim needs `min` independent hits; an index written before `min` existed means 1.
      const need = typeof entry.min === "number" && entry.min > 0 ? entry.min : 1;
      const terms = Array.isArray(entry.terms) ? entry.terms : [];
      return terms.filter((t) => typeof t === "string" && hit(t)).length >= need;
    };
    for (const entry of userPrefEntries) {
      if (!entry || typeof entry.line !== "string" || deliveredPrefs.has(entry.id)) continue;
      if (!matches(entry)) continue;
      userPrefLines.push(entry.line);
      freshUserPrefIds.push(entry.id);
      if (userPrefLines.length >= 5) break;
    }
    // Oversight and expertise leases (user-intelligence/turn-guidance.ts): one risk-rule hit each.
    for (const g of guidanceEntries) {
      if (!g || typeof g.line !== "string" || typeof g.heading !== "string" || deliveredPrefs.has(g.id)) continue;
      if (Array.isArray(g.terms) && g.terms.some(riskHit)) { guidanceLines.push(g); freshUserPrefIds.push(g.id); }
    }
  }

  if (
    !shouldInjectMeta &&
    !shouldInjectDigest &&
    !shouldInjectProtocol &&
    !shouldInjectProfiles &&
    !filenameInlineBlock &&
    !invokedSkillBlock &&
    !patternImportBlock &&
    !priorWorkBlock &&
    !handoffBlock &&
    !navigationBlock &&
    !navigationBodyBlock &&
    !advisoryBlock &&
    projectRules.length === 0 &&
    promptSemanticCandidates.length === 0 &&
    !refreshLine && userPrefLines.length === 0 && guidanceLines.length === 0 && !(index.capture_reminder && mcpAvailableForSession())
  ) {
    logLatency(eventName, null, "skip_meta_throttled");
    emitEmpty();
  }

  const digest = stripPendingRefreshDigest(index.session_digest);

  const lines = [];

  if (shouldInjectMeta) {
    lines.push("📋 Pathrule session metadata");
    lines.push(`- workspace_id: \`${workspaceId}\``);
    lines.push(`- workspace_root: \`${index.workspace_root}\``);
    lines.push("");
  }

  if (invokedSkillBlock) {
    lines.push(invokedSkillBlock);
    lines.push("");
  }

  if (patternImportBlock) {
    lines.push(patternImportBlock);
    lines.push("");
  }

  if (priorWorkBlock) {
    lines.push(priorWorkBlock);
    lines.push("");
  }

  if (handoffBlock) {
    lines.push(handoffBlock);
    lines.push("");
  }

  if (navigationBlock) {
    lines.push(navigationBlock);
    lines.push("");
  }

  if (navigationBodyBlock) {
    lines.push(navigationBodyBlock);
    lines.push("");
  }

  if (shouldInjectDigest && digest && digest.length > 0) {
    lines.push(digest);
  }

  if (refreshLine) {
    lines.push("");
    lines.push(refreshLine);
  }

  if (projectRules.length > 0) {
    lines.push("");
    lines.push("**Project rules relevant to this prompt:**");
    for (const r of projectRules) {
      const badge = r.enforcement === "strict" ? "🚨 " : "";
      lines.push(`- ${badge}${r.name} (${r.priority})`);
    }
    if (state) {
      state.prompt_project_rule_ids = Array.from(
        new Set([...(state.prompt_project_rule_ids ?? []), ...projectRules.map((r) => r.id)]),
      );
      writeSessionState(state);
    }
  }

  if (promptSemanticCandidates.length > 0) {
    lines.push("");
    lines.push("**Possible semantic memory candidates:**");
    for (const candidate of promptSemanticCandidates) {
      lines.push(
        `- ${candidate.title} (id: ${candidate.id}, ${candidate.confidence}, ${candidate.node_path})`,
      );
    }
    lines.push("Read the memory body before using a semantic candidate as evidence.");
    if (state) {
      state.semantic_candidate_ids = Array.from(
        new Set([
          ...(state.semantic_candidate_ids ?? []),
          ...promptSemanticCandidates.map((candidate) => candidate.id),
        ]),
      );
      writeSessionState(state);
    }
  }

  // Compiled Agent IR advisories: a clearly subordinate section AFTER the rules/memories, so the agent
  // never reads advice with the authority of a rule (the header text states it never overrides a rule,
  // constraint, or security policy). Delivery is recorded below, only once the context actually emits.
  if (advisoryBlock) {
    lines.push("");
    lines.push(advisoryBlock);
  }

  // Rendered after the advisories: a preference or an oversight note must never read with a rule's authority.
  if (userPrefLines.length > 0) lines.push("", USER_PREFERENCE_HEADING, ...userPrefLines);
  for (const heading of new Set(guidanceLines.map((g) => g.heading))) {
    lines.push("", heading, ...guidanceLines.filter((g) => g.heading === heading).map((g) => g.line));
  }

  if (filenameInlineBlock) lines.push(filenameInlineBlock.text); // filename-scoped inline block, computed pre-throttle.

  // Full-body blocks (invoked skill/recovery, filename inline, routed-path bodies) need the larger
  // delta budget; the preview-only path keeps the tight MAX_CONTEXT_CHARS ceiling.
  const hasFullBody = !!invokedSkillBlock || !!navigationBodyBlock || !!filenameInlineBlock;
  const cap = hasFullBody ? DELTA_MAX_CONTEXT_CHARS : MAX_CONTEXT_CHARS;
  let context = lines.join("\n");
  if (context.length > cap) context = context.slice(0, cap) + "…";
  // The provider's limit covers everything this output carries, framing included.
  context = fitProviderLimit(context, framingLength).text;
  // A body the cuts above removed was selected, not delivered: it goes back to undelivered so a
  // later prompt can carry it, and the ledger records why it did not arrive.
  const keptBodies = [];
  const cutBodies = [];
  for (const item of lastBodyDelivered) (context.includes(item.block) ? keptBodies : cutBodies).push(item);
  if (filenameInlineBlock && filenameInlineBlock.memoryId) {
    const item = { id: filenameInlineBlock.memoryId, hash: null, kind: "memory", block: filenameInlineBlock.text.trim() };
    (context.includes(item.block) ? keptBodies : cutBodies).push(item);
  }
  if (cutBodies.length > 0 && state) {
    for (const item of cutBodies) {
      if (state.injected_memory_hashes) delete state.injected_memory_hashes[item.id];
      state.injected_memory_ids = (state.injected_memory_ids ?? []).filter((id) => id !== item.id);
    }
    writeSessionState(state);
    recordCutDeliveries(workspaceId, cutBodies);
  }
  const promptDeliveries = keptBodies.map((item) => ({ kind: item.kind, id: item.id, hash: item.hash, scope: "project" }));
  // Prepended after the cap on purpose: the once-per-session protocol is framing, and folding it into `lines`
  // would push ranked bodies past MAX_CONTEXT_CHARS on every session's first prompt, where they matter most.
  // The profiles are framing too, bounded when the index is written, and follow the protocol.
  if (shouldInjectProfiles) {
    context = context.length > 0 ? `${sessionProfiles.block}\n\n${context}` : sessionProfiles.block;
  }
  if (shouldInjectProtocol && sessionProtocol) {
    context = context.length > 0 ? `${sessionProtocol}\n\n${context}` : sessionProtocol;
  }
  if (typeof index.capture_reminder === "string" && index.capture_reminder && mcpAvailableForSession()) context = context ? `${context}\n\n${index.capture_reminder}` : index.capture_reminder;
  const latencyParts = [];
  if (shouldInjectProtocol) latencyParts.push("protocol");
  if (shouldInjectProfiles) latencyParts.push("profiles");
  if (shouldInjectMeta) latencyParts.push("meta");
  if (shouldInjectDigest && digest && digest.length > 0) latencyParts.push("digest");
  if (projectRules.length > 0) latencyParts.push("project_rules");
  if (refreshLine) latencyParts.push("refresh");
  if (invokedSkillBlock) latencyParts.push("skills");
  if (patternImportBlock) latencyParts.push("pattern_import");
  if (priorWorkBlock) latencyParts.push("prior_work");
  if (handoffBlock) latencyParts.push("handoff");
  if (navigationBlock) latencyParts.push("route");
  if (navigationBodyBlock) latencyParts.push("route_body");
  if (filenameInlineBlock) latencyParts.push("filename");
  if (promptSemanticCandidates.length > 0) latencyParts.push("semantic");
  if (advisoryBlock) latencyParts.push("advisories");
  if (userPrefLines.length > 0) latencyParts.push("user_prefs");
  if (guidanceLines.length > 0) latencyParts.push("guidance");
  const latencyTag = latencyParts.length > 0 ? `inject_${latencyParts.join("+")}` : "inject_empty_context";
  logLatency(eventName, null, latencyTag);

  // Record advisory delivery to the shared ledger ONLY when the context actually emits, mirroring the
  // PreToolUse path: `delivered` is not `used`, and recording here stops the PreToolUse path from
  // re-delivering the same advisory later this session. A preference the cap cut is not delivered.
  if (freshUserPrefIds.length > 0 && context.length > 0 && state) {
    state.delivered_user_pref_ids = Array.from(
      new Set([...(state.delivered_user_pref_ids ?? []), ...freshUserPrefIds.filter((id) => context.includes([...userPrefEntries, ...guidanceEntries].find((e) => e && e.id === id)?.line ?? "\u0000"))]),
    );
    writeSessionState(state);
  }
  if (advisoryBlock && freshAdvisoryRefs.length > 0 && context.length > 0 && state) {
    state.delivered_advisory_refs = Array.from(
      new Set([...(state.delivered_advisory_refs ?? []), ...freshAdvisoryRefs]),
    );
    recordRemedyDeliveries(workspaceId, sessionId, toRelative(cwd, index.workspace_root) ?? "/", freshAdvisoryRefs);
    writeSessionState(state);
  }

  if (shouldInjectProtocol && sessionProtocol) {
    promptDeliveries.push({ kind: "protocol", id: "pathrule-protocol", hash: shortHash(sessionProtocol), scope: "project" });
  }
  if (shouldInjectProfiles) {
    promptDeliveries.push({ kind: "profile", id: "profiles", hash: String(sessionProfiles.version), scope: "team" });
  }
  if (context.length > 0) recordDeliveries(workspaceId, promptDeliveries);
  recordInjection({
    workspaceId,
    sessionId,
    toolName: "UserPromptSubmit",
    filePath: null,
    ruleCount: projectRules.length,
    memoryCount: promptSemanticCandidates.length,
    decision: null,
    ruleIds: projectRules.map((r) => r.id).filter(Boolean),
    memoryIds: promptSemanticCandidates.map((candidate) => candidate.id).filter(Boolean),
    skillIds: skillResolution?.found?.map((s) => s.id).filter(Boolean) ?? [],
    injectionStrategyBreakdown: m44PromptRuleResult.breakdown,
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

// What is one person's (the profile block, `intelligence_profiles.owner`; learned preferences and
// guidance, `personal_owner`) goes out only while that account is signed in here: the owner its
// sign-in recorded in account-owners.json (no token; core/storage/account-owners.ts). Entries with no
// owner are the accountless local person's and always go. Signed out, switched or revoked: nothing.
function signedInAccountIds() {
  const ids = new Set();
  // A missing or corrupt file or slot proves nobody.
  const parse = (load) => { try { return JSON.parse(load()); } catch { return null; } };
  const read = (file) => parse(() => fs.readFileSync(file, "utf8"));
  for (const home of new Set([PATHRULE_HOME, path.join(os.homedir(), ".pathrule")])) {
    const record = read(path.join(home, "account-owners.json"));
    if (record && record.schema_version === 1 && record.owners && typeof record.owners === "object") {
      for (const entry of Object.values(record.owners)) {
        if (entry && typeof entry.user_id === "string" && entry.user_id) ids.add(entry.user_id);
      }
    }
  }
  return ids;
}

function ownerSignedIn(owner) {
  return typeof owner === "string" && owner.trim() !== "" && signedInAccountIds().has(owner.trim());
}

function deliverableProfiles(idx) {
  const p = idx && idx.intelligence_profiles;
  if (!p || typeof p.block !== "string" || p.block.trim() === "") return null;
  if (typeof p.version !== "string" || !ownerSignedIn(p.owner)) return null;
  return { block: p.block.trim(), version: p.version };
}

function handleSessionStart() {
  // Cursor's PreToolUse + beforeSubmitPrompt outputs cannot carry
  // additional_context (https://cursor.com/docs/agent/hooks). SessionStart is
  // the only entry point that bootstraps Pathrule context for Cursor. Claude
  // also benefits — meta lands one event earlier, and the digest_injected /
  // user_prompt_count flags below keep the first UserPromptSubmit from
  // double-injecting the same payload.
  const state = sessionFile ? readSessionState() : null;
  pruneEventClaims(null);
  // A stale index is refreshed in the background for the next prompt; this one is not held up.
  maybeRefreshIndex(index);
  if (isExplicitContextResetEvent()) startDeliveryEpoch(workspaceId, event.source);
  if (state && isExplicitContextResetEvent()) {
    state.injected_rule_ids = [];
    state.injected_memory_ids = [];
    state.delivered_advisory_refs = []; // atoms the summary dropped reach the next edit again
    state.prompt_project_rule_ids = [];
    state.rule_injection_records = {};
    state.file_tool_count = 0;
    state.digest_injected = false;
    state.protocol_injected = false;
    state.route_guidance_injected = false;
    state.delivered_profile_version = null;
    // A compaction empties the window, so the growth history describes a session
    // that no longer exists. Keeping it would report pressure on a fresh context.
    state.transcript_marks = [];
    state.user_prompt_count = 0;
    writeSessionState(state);
  }
  if (state && state.digest_injected === true) {
    logLatency(eventName, null, "skip_already_bootstrapped");
    emitEmpty();
  }

  const digest = stripPendingRefreshDigest(index.session_digest);
  const lines = [];

  lines.push("📋 Pathrule session metadata");
  lines.push(`- workspace_id: \`${workspaceId}\``);
  lines.push(`- workspace_root: \`${index.workspace_root}\``);
  lines.push("");

  if (digest && digest.length > 0) {
    lines.push(digest);
    lines.push("");
  }

  let context = lines.join("\n");
  if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS) + "…";

  // The protocol rides SessionStart because that is the channel that survives
  // compaction: Claude Code merges SessionStart's additionalContext into the
  // SYSTEM PROMPT for the session, while UserPromptSubmit's lands in the turn and
  // is summarised away with everything else. In signature mode the hook is the
  // protocol's ONLY channel — the disk copy is deliberately removed — so losing it
  // to a compaction leaves the agent with framing it cannot re-derive and no way
  // to notice. The UserPromptSubmit path stays as the fallback for a session whose
  // SessionStart never reached us.
  //
  // Prepended after the cap for the same reason as on a prompt: the protocol is
  // framing, not a ranked item, and folding it into `lines` would push the digest
  // out of the bootstrap of every session.
  //
  // The team block and the project-wide (root) knowledge ride the same delivery for
  // the same reason: in signature mode no compiled file carries them. They are framing
  // too (constant for the workspace, not selected for the prompt), so they share the
  // protocol's flag rather than earning a second one.
  const bootstrapProtocol = sessionProtocolText();
  const bootstrapTeam =
    typeof index.team_context === "string" && index.team_context.trim().length > 0
      ? index.team_context.trim()
      : null;
  const projectKnowledge = typeof index.project_knowledge === "string" && instructionMemoryIds(index).size === 0 ? index.project_knowledge : null;
  const deliverProtocol =
    (!!bootstrapProtocol || !!bootstrapTeam || !!projectKnowledge) && (!state || state.protocol_injected !== true);
  // The profiles are framing as well (constant for the session, not selected for a prompt), so they
  // ride the same delivery, after the team block they rank below. Their own version gates them:
  // unlike the protocol they exist outside signature mode too.
  const profiles = deliverableProfiles(index);
  const deliverProfiles =
    !!profiles && (!state || state.delivered_profile_version !== profiles.version);
  if (deliverProtocol || deliverProfiles) {
    const framing = [
      deliverProtocol ? bootstrapProtocol : null,
      deliverProtocol ? bootstrapTeam : null,
      deliverProtocol ? projectKnowledge : null,
      deliverProfiles ? profiles.block : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    // Framing is never cut; the metadata and digest after it fit the provider's limit or are cut.
    const fitted = fitProviderLimit(context, framing.length + 2);
    context = fitted.text.length > 0 ? `${framing}\n\n${fitted.text}` : framing;
  } else {
    context = fitProviderLimit(context, 0).text;
  }
  const framingDeliveries = [];
  if (deliverProtocol && bootstrapProtocol) {
    framingDeliveries.push({ kind: "protocol", id: "pathrule-protocol", hash: shortHash(bootstrapProtocol), scope: "project" });
  }
  if (deliverProtocol && bootstrapTeam) {
    framingDeliveries.push({ kind: "profile", id: "team-context", hash: shortHash(bootstrapTeam), scope: "team" });
  }
  if (deliverProfiles) framingDeliveries.push({ kind: "profile", id: "profiles", hash: String(profiles.version), scope: "team" });
  recordDeliveries(workspaceId, framingDeliveries);

  if (state) {
    state.digest_injected = true;
    if (deliverProtocol) state.protocol_injected = true;
    if (deliverProfiles) state.delivered_profile_version = profiles.version;
    // Pre-bump prompt counter so the first UserPromptSubmit (Claude only) sees
    // (count-1)%3 != 0 and skips redundant meta — next inject lands at prompt 4.
    state.user_prompt_count = Math.max(state.user_prompt_count ?? 0, 1);
    writeSessionState(state);
  }

  logLatency(
    eventName,
    null,
    `inject_session_bootstrap${deliverProtocol ? "+protocol" : ""}${deliverProfiles ? "+profiles" : ""}`,
  );
  recordInjection({
    workspaceId,
    sessionId,
    toolName: "SessionStart",
    filePath: null,
    ruleCount: 0,
    memoryCount: 0,
    decision: null,
    ruleIds: [],
    memoryIds: [],
    skillIds: [],
  });
  emit({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

// Clients whose PreToolUse cannot inject context — path-scoped memory/rule
// injection happens reactively on PostToolUse instead (Cursor's PreToolUse is
// permission-only; Copilot CLI accepts additionalContext only after the tool).
const REACTIVE_POST_TOOL_SHAPES = new Set(["cursor", "copilot"]);

function handlePostToolUse() {
  // Reactive branch — for REACTIVE_POST_TOOL_SHAPES, path-scoped memory/rule
  // injection happens here after Read / Edit / Write succeeds. Claude flow is
  // unchanged: PreToolUse already injected pre-emptively, we only capture
  // failure patterns below.
  // Claude Code does NOT send PostToolUse for a failed tool. It sends
  // PostToolUseFailure, a separate event with NO tool_response: the message is a
  // top-level `error` STRING, alongside `is_interrupt` and `duration_ms`. Measured
  // 2026-08-22 — a Read of a missing file produced exactly one event, this one, with
  // error = "File does not exist. Note: your current working directory is …".
  //
  // This is why the friction pipe recorded zero failure codes for its whole life: the
  // hook was only ever handed the successes. Normalise both shapes here so everything
  // downstream (the outcome record, fail-patterns.jsonl) is unchanged.
  const isFailureEvent = eventName === "PostToolUseFailure";
  const response = event.tool_response;
  const failureText = isFailureEvent && typeof event.error === "string" ? event.error : null;
  const isError =
    isFailureEvent || Boolean(response && (response.is_error === true || hasErrorShape(response)));

  // The tool's canonical name, for every client: the CHECK evidence below and the
  // observation capture after it both key on it.
  const canonicalTool = m46CanonicalToolName(toolName, clientShape);
  try {
    const toolInput = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : null;
    // Telemetry for every completed call, success and failure alike, is the cloud extension's:
    // the outcome, and for a shell command what it explored (which notes a route follow-through).
    const cloud = cloudExtension();
    const exploration = cloud && canonicalTool === "bash" ? cloud.exploreBash(command) : null;
    let verification = null;
    let verificationEvidence = null;
    const explicitSuccessAttested = verificationAdapterSuccessAttested || (eventName === "PostToolUse" && toolName === "Bash" && (clientShape === "claude" || clientShape === "codex"));
    const verificationResult = canonicalTool === "bash" ? confirmedVerificationResult(response,isFailureEvent,explicitSuccessAttested) : null;
    if (canonicalTool === "bash") {
      // Independent of exploration: this answers "did the required verification pass",
      // which a category cannot, and it stays null whenever attribution is unsafe.
      verification = classifyVerificationCommand(command);
      verificationEvidence = classifyVerificationEvidenceCommand(command);
      // CHECK evidence. Only a PASS clears, and only for the exact canonical form the
      // requirement names: a FAIL, an unrecognised command, or a different package's
      // suite leaves the check owed. `isError` is the tool's own exit status, and the
      // evidence channel refuses to fingerprint any command whose exit status belongs to
      // something else (a pipe), so the two are about the same run.
      if (verificationEvidence) {
        try {
          const state = readSessionState();
          const pending = Array.isArray(state.pending_checks) ? state.pending_checks : [];
          const satisfied = Array.isArray(state.satisfied_checks) ? state.satisfied_checks : [];
          // Derive expected v2 from the authored command. Legacy fp remains stored and
          // parsed unchanged; old lossy observations never clear an approved CHECK.
          let changed = false;
          if (verificationResult === true) {
            const kept = [];
            for (const entry of pending) {
              if (!entry || classifyVerificationEvidenceCommand(entry.command) !== verificationEvidence) {kept.push(entry);continue;}
              // A full retention ledger fails closed: keep new debt owed rather than
              // forgetting its command and allowing a later failed rerun to disappear.
              if (satisfied.length >= 256) {kept.push(entry);continue;}
              satisfied.push(entry);changed=true;
            }
            state.pending_checks = kept;
            state.satisfied_checks = satisfied;
          } else {
            state.satisfied_checks = satisfied.filter(entry => {
              if (!entry || classifyVerificationEvidenceCommand(entry.command) !== verificationEvidence) return true;
              if (!pending.some(owed => owed && owed.rule_id === entry.rule_id && owed.command === entry.command)) pending.push(entry);
              changed=true;return false;
            });
            state.pending_checks = pending;
          }
          if (changed) {
            writeSessionState(state);
            logLatency(eventName, canonicalTool, (verificationResult === true ? "check_satisfied:" : verificationResult === false ? "check_failed:" : "check_unconfirmed:") + verificationEvidence);
          }
        } catch {
          // Never break the hook on ledger errors.
        }
      }
    }
    if (cloud) {
      cloud.recordToolOutcome({ response, failureText, isError, canonicalTool, exploration, verification, verificationEvidence, verificationResult });
    }
  } catch {
    // Never break the hook on telemetry or ledger errors.
  }

  try { /* noted for a derived activity row (core auto-activity-drain.ts): no agent step logs it */ const fp = event.tool_input?.file_path || event.tool_input?.path; if (!isError && (canonicalTool === "edit" || canonicalTool === "write") && typeof fp === "string" && index.workspace_root) fs.appendFileSync(path.join(CACHE_DIR, workspaceId, "auto-activity.jsonl"), JSON.stringify({ sid: sessionId, at: new Date().toISOString(), tool: canonicalTool, path: "/" + m43NormalizePath(fp, index.workspace_root) }) + "\n", { mode: 0o600 }); } catch { /* best effort */ }
  // V30 — capture an observable tool event for outcome observation, but ONLY when this session
  // was actually delivered an advisory (otherwise there is nothing to attribute and no reason to
  // write). The raw before/after/command lands in a LOCAL, ephemeral ledger that the backend drains
  // and reduces to categorical evidence; this file is never synced and carries no attribution
  // decision. The hook does capture only: the deterministic engine lives in one place, the backend.
  try {
    const obsState = readSessionState();
    const deliveredRefs = Array.isArray(obsState.delivered_advisory_refs) ? obsState.delivered_advisory_refs : [];
    if (deliveredRefs.length > 0) {
      const ti = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
      const wsRoot = index && index.workspace_root ? index.workspace_root : null;
      const relOf = (p) =>
        typeof p === "string" && wsRoot ? "/" + m43NormalizePath(p, wsRoot) : null;
      let obs = null;
      if (canonicalTool === "edit" && typeof ti.old_string === "string" && typeof ti.new_string === "string") {
        const p = relOf(ti.file_path || ti.path);
        if (p) obs = { kind: "edit", path: p, before: ti.old_string, after: ti.new_string };
      } else if (canonicalTool === "write" && typeof ti.content === "string") {
        const p = relOf(ti.file_path || ti.path);
        if (p) obs = { kind: "write", path: p, after: ti.content };
      } else if (canonicalTool === "bash" && typeof ti.command === "string") {
        const exit =
          response && typeof response.exit_code === "number" ? response.exit_code : isError ? 1 : 0;
        const out = failureText || (response && response.stderr) || null;
        obs = { kind: "command", command: ti.command, exit_code: exit };
        if (out) obs.output = String(out).slice(0, 4000);
      }
      if (obs) {
        const obsDir = path.join(CACHE_DIR, workspaceId);
        fs.mkdirSync(obsDir, { recursive: true });
        const rec = { sid: sessionId, at: new Date().toISOString(), event: obs };
        fs.appendFileSync(
          path.join(obsDir, "knowledge-observations.jsonl"),
          JSON.stringify(rec) + "\n",
        );
        logLatency(eventName, toolName, "knowledge_obs_captured");
      }
    }
  } catch {
    // Never break the hook on observation-capture errors.
  }

  if (!isError && REACTIVE_POST_TOOL_SHAPES.has(clientShape)) {
    const reactiveContext = buildReactivePostToolContext();
    if (reactiveContext) {
      logLatency(eventName, toolName, "inject_post_" + clientShape);
      emit({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reactiveContext,
        },
      });
    }
  }

  if (!isError) {
    logLatency(eventName, toolName, "noop_success");
    emitEmpty();
  }

  try {
    const fpDir = path.join(CACHE_DIR, workspaceId);
    fs.mkdirSync(fpDir, { recursive: true });
    const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    const rel = filePath ? toRelative(filePath, index.workspace_root) : null;

    const errorPreview = failureText || extractErrorPreview(response);
    const signature = crypto
      .createHash("sha1")
      .update((toolName ?? "") + "|" + errorPreview.slice(0, 200))
      .digest("hex")
      .slice(0, 12);

    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      file_path: rel,
      error_signature: signature,
      error_preview: errorPreview.slice(0, 200),
    };
    fs.appendFileSync(path.join(fpDir, "fail-patterns.jsonl"), JSON.stringify(entry) + "\n");
    logLatency(eventName, toolName, "fail_captured");
  } catch {
    logLatency(eventName, toolName, "fail_capture_error");
  }

  emitEmpty();
}

/**
 * Turn end. The only place a CHECK can be enforced: it is where "the work is finished"
 * is claimed, and the only hook event whose output can send the agent back to work.
 *
 * Blocks with `decision: "block"` plus the authored message and the exact command, so
 * the agent has something to do rather than a refusal. A block that does not say what
 * to run is a stuck turn.
 */
function handleStop() {
  // Recursion guard. Claude Code re-runs Stop after a block, and without this the turn
  // could never end even once the verification passed, because the block would re-fire
  // on its own continuation.
  if (event.stop_hook_active === true) {
    logLatency(eventName, null, "turn_end:stop_hook_active");
    emitEmpty();
    return;
  }
  // The turn is over: captured learning evidence can be processed now, in the background.
  maybeDrainLearning(index);
  let pending = [];
  try {
    const state = readSessionState();
    pending = Array.isArray(state.pending_checks) ? state.pending_checks.filter(Boolean) : [];
  } catch {
    pending = [];
  }
  if (pending.length === 0) {
    logLatency(eventName, null, "turn_end");
    emitEmpty();
    return;
  }

  const lines = [];
  lines.push("🚦 Pathrule is holding this turn open: a required verification has not passed.");
  lines.push("");
  for (const p of pending) {
    lines.push(`- **${p.rule_name || "Required check"}**`);
    if (p.message) lines.push(`  ${p.message}`);
    lines.push("  Run: `" + String(p.command) + "`");
  }
  lines.push("");
  lines.push(
    "Run it and let it finish without piping the output; a pipe moves the exit code off the command, so the result cannot be read as evidence.",
  );

  logLatency(eventName, null, "check_block:" + pending.length);
  recordInjection({
    workspaceId,
    sessionId,
    toolName: eventName,
    filePath: null,
    ruleCount: pending.length,
    memoryCount: 0,
    decision: "check_block",
    ruleIds: pending.map((p) => p.rule_id).filter(Boolean),
    memoryIds: [],
    skillIds: [],
  });
  emit({ decision: "block", reason: lines.join("\n") });
}

function handleSessionEnd() {
  if (sessionStem) pruneEventClaims(sessionStem);
  // Savings accounting, for the cloud extension's route history: before deleting the
  // ledger, write a one-line session summary so the ROI aggregator can compare routed vs
  // unrouted sessions from the user's OWN data (tool count, duration, route follow).
  const cloud = sessionFile && fs.existsSync(sessionFile) ? cloudExtension() : null;
  if (cloud) {
    try {
      const state = readSessionState();
      const startedMs = Date.parse(state.created_at ?? "");
      cloud.logNavigation(workspaceId, {
        t: "session",
        session_id: sessionId,
        file_tool_count: state.file_tool_count ?? 0,
        routed: typeof state.last_route_signature === "string" && state.last_route_signature.length > 0,
        followed: state.route_followed_logged === true,
        prompts: state.user_prompt_count ?? 0,
        duration_s: Number.isFinite(startedMs) ? Math.round((Date.now() - startedMs) / 1000) : null,
      });
    } catch {
      /* summary is best-effort */
    }
  }
  // Keep the ledger: the session can be resumed, and its transcript still holds what was delivered
  // (measured 2026-10-15: deleting it re-delivered everything on every resume). Only a /clear empties
  // the transcript; the host's daily rotation reaps ledgers older than its retention.
  if (sessionFile && event.reason === "clear" && fs.existsSync(sessionFile)) {
    try {
      fs.unlinkSync(sessionFile);
    } catch {
      // Non-fatal — telemetry rotation will clean up stale files > 24h old.
    }
  }
  logLatency(eventName, null, "session_end");
  emitEmpty();
}

// Cursor-only path-scoped post-tool injection. Mirrors handlePreToolUse's
// dedup + relevance pipeline without the BLOCK_PATTERN check (already
// resolved at PreToolUse). Returns a formatted string or null.
function buildReactivePostToolContext() {
  const isFileTool = toolName === "Read" || toolName === "Edit" || toolName === "Write";
  if (!isFileTool) return null;
  const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  const filePath = typeof input.file_path === "string" ? input.file_path : null;
  if (typeof filePath !== "string") return null;

  const rel = toRelative(filePath, index.workspace_root);
  if (!rel) return null;

  const allMemories = matchMemoriesForPath(index, rel, 12);
  const allRules = matchRulesForPath(index, rel, 12);
  const failPatterns = matchFailPatterns(index, rel, 2);

  const newString = String(input.new_string ?? input.content ?? "");
  const contextTokens = new Set();
  for (const t of tokenize(rel)) contextTokens.add(t);
  for (const t of tokenize(newString.slice(0, 2000))) contextTokens.add(t);
  const contextSemanticTags = inferSemanticTags(
    semanticTextFromToolInput(newString).slice(0, 2000),
    "",
  );

  const state = readSessionState();
  state.file_tool_count = (state.file_tool_count ?? 0) + 1;
  const seenMemoryIds = new Set(state.injected_memory_ids);
  const contextText = `${rel} ${newString.slice(0, 2000)}`;

  const { fullRules: filteredRules, safetyRules } = selectAdvisoryRules({
    allRules,
    contextTokens,
    contextSemanticTags,
    contextText,
    relativePath: rel,
    failPatterns,
    state,
  });

  const filteredMemoryCandidates = [];
  let memoryIndex = 0;
  for (const m of allMemories) {
    const currentIndex = memoryIndex++;
    if (seenMemoryIds.has(m.id)) continue;
    const score = memoryRelevanceScore(contextTokens, `${m.title} ${m.preview}`);
    const tagPart = semanticTagScore(contextSemanticTags, m.semantic_tags);
    // Path relation WEIGHTS the match instead of merely admitting it.
    // matchMemoriesForPath walks ANCESTORS, so everything attached anywhere above this
    // file is a candidate, and memoryThreshold asks for a single shared token once the
    // node is deeper than 2. That combination put "Preserve the E2E encryption contract"
    // and "Studio native macOS menu" on an edit to a Kanban board file (measured
    // 2026-08-23): both hang above /studio and both share exactly the token "studio"
    // with the file path.
    //
    // Tiered, a lone token from an ancestor (1 × 0.85) no longer clears a threshold of
    // 1, while the same token on the EXACT node (1 × 1.0) still does, and two shared
    // tokens from an ancestor (1.7) still do. Path becomes a definite signal rather than
    // one more word in the bag.
    // The tier RANKS, it does not GATE. That distinction cost a real regression.
    //
    // Gating on `score × tier` means a threshold of 1 can only ever be cleared from the
    // exact node, because any ancestor multiplier is below 1. The AI-contract suite caught
    // it: "Translation file workflow" is attached to /packages/app/src/i18n, the edit is
    // /packages/app/src/i18n/translations/tr.ts, it shares one token, and it was dropped —
    // a genuine match, silently withheld.
    //
    // The off-topic items that motivated tiering in the first place turned out to be RULES,
    // not memories ("Preserve the E2E encryption contract" on a Kanban file is a project
    // rule), and rules had no relevance gate at all. That is fixed on its own path now.
    //
    // So admission stays where it was and the tier decides ORDER. Cost is controlled by the
    // body/name graduation instead: a weakly related ancestor memory can still arrive, as a
    // name, which is visibility without the 1.400 chars.
    const tier = pathRelationTier(m.node_path, rel);
    if (score < memoryThreshold(m, 1) && !(score >= 1 && tagPart.score >= 4)) continue;
    filteredMemoryCandidates.push({
      memory: m,
      score: (score * 3 + tagPart.score) * tier,
      depth: pathDepth(m.node_path),
      index: currentIndex,
    });
  }
  filteredMemoryCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depth !== a.depth) return b.depth - a.depth;
    return a.index - b.index;
  });
  const filteredMemories = filteredMemoryCandidates.map((item) => item.memory).slice(0, 3);

  const context = formatInjectionContext({
    relativePath: rel,
    memories: filteredMemories,
    rules: filteredRules,
    safetyRules,
    failPatterns,
  });

  if (!context) {
    writeSessionState(state);
    return null;
  }

  for (const m of filteredMemories) {
    if (!seenMemoryIds.has(m.id)) state.injected_memory_ids.push(m.id);
  }
  writeSessionState(state);

  recordInjection({
    workspaceId,
    sessionId,
    toolName: "PostToolUse",
    filePath: rel,
    ruleCount: filteredRules.length + safetyRules.length,
    memoryCount: filteredMemories.length,
    decision: null,
    ruleIds: [...filteredRules, ...safetyRules].map((r) => r.id).filter(Boolean),
    memoryIds: filteredMemories.map((m) => m.id).filter(Boolean),
    skillIds: [],
  });
  return context;
}

function hasErrorShape(response) {
  if (!response) return false;
  if (response.error) return true;
  if (typeof response.exit_code === "number" && response.exit_code !== 0) return true;
  // Claude Code's Bash PostToolUse payload carries NONE of the fields above. Measured
  // 2026-08-22 by capturing the real shape: the keys are
  // {stdout, stderr, interrupted, isImage, noOutputExpected} — no is_error, no exit_code,
  // no duration_ms, and stderr comes back EMPTY even for a command that printed to it
  // (the text is folded into stdout). So a non-zero exit is invisible to the hook on that
  // client, and no amount of parsing here recovers it. The adapter's own tests assert
  // payloads with exit_code/is_error/duration_ms, which is why this looked fine in
  // isolation for months.
  //
  // `interrupted` is the one failure signal Claude Code does send (timeout, or the user
  // stopping the turn). Reading it is strictly better than reading nothing: a timed-out
  // command is exactly the kind of friction worth recording. Everything else on this
  // client stays unobservable until the payload carries an exit code.
  if (response.interrupted === true) return true;
  return false;
}

function extractErrorPreview(response) {
  if (!response) return "";
  if (typeof response.error === "string") return response.error;
  if (typeof response.stderr === "string" && response.stderr.length > 0) return response.stderr;
  if (typeof response.content === "string") return response.content;
  try {
    return JSON.stringify(response).slice(0, 500);
  } catch {
    return "";
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

switch (eventName) {
  case "SessionStart":
    handleSessionStart();
    break;
  case "PreToolUse":
    void handlePreToolUse().catch(() => emitEmpty());
    break;
  case "UserPromptSubmit":
    // Neither Cursor's beforeSubmitPrompt nor Copilot's userPromptSubmitted
    // can accept additional context — those clients get it via SessionStart
    // and PostToolUse instead. The renderers drop this matcher from their
    // hook configs, but we short-circuit defensively in case the client is
    // reading .claude/settings.json directly (VS Code agent mode does).
    if (clientShape === "cursor" || clientShape === "copilot") {
      logLatency(eventName, null, "skip_" + clientShape + "_unsupported");
      emitEmpty();
    }
    handleUserPromptSubmit();
    break;
  case "PostToolUse":
  // Claude Code's failure counterpart of PostToolUse. Same handler: it normalises the
  // two payload shapes internally.
  case "PostToolUseFailure":
    handlePostToolUse();
    break;
  case "Stop":
  case "SubagentStop":
    // Each turn ends with Stop. The session ledger (digest_injected,
    // user_prompt_count, injected_*_ids) MUST persist across turns or the
    // prompt-refresh throttle never accumulates and every prompt re-injects meta+digest.
    handleStop();
    break;
  case "SessionEnd":
    handleSessionEnd();
    break;
  default:
    logLatency(eventName ?? "unknown", toolName, "noop_event");
    emitEmpty();
}
