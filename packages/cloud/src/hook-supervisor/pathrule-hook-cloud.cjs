// SPDX-License-Identifier: Apache-2.0
// Pathrule hook extension: cloud.
//
// pathrule-hook.js loads this module from its own directory when it is there (the contract is
// @pathrule/protocol/hook-extension.ts). It carries what a Pathrule Cloud workspace adds to the
// hook: ranking over the hosted index, the teammate work-state check, and local telemetry files
// (tool outcomes and exploration, route history, the injection log).
//
// Self-contained like the hook it extends: Node built-ins only, no node_modules. The blocks below
// moved out of the hook unchanged; `create(host)` binds the hook's paths, event and helpers to the
// names they always used.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

/** Must match HOOK_EXTENSION_CONTRACT in @pathrule/protocol/hook-extension.ts and the hook's loader. */
const HOOK_EXTENSION_CONTRACT = 1;

// Bound by create(host), once per hook process, before any function below runs.
let PATHRULE_HOME = null;
let CACHE_DIR = null;
let OUTCOMES_DIR = null;
let NAVIGATION_DIR = null;
let CLOUD_SEMANTIC_HELPER_PATH = null;
let event = null;
let eventName = null;
let toolName = null;
let cwd = null;
let sessionId = null;
let sessionFile = null;
let clientShape = null;
let index = null;
let workspaceId = null;
let logLatency = null;
let emit = null;
let emitEmpty = null;
let readSessionState = null;
let writeSessionState = null;
let toRelative = null;
let normalizeWorkspacePath = null;
// The hook's ranking limit and floor, passed with each rankPrompt call.
let SEMANTIC_INJECT_TOPK = null;
let SEMANTIC_INJECT_MIN = null;

// ─── Tool outcome buffer (inline) ────────────────────────────────────────────
//
// Inlined here because this file ships standalone to ~/.pathrule/bin/ and
// cannot require from the TS package. The failure classification mirrors
// @pathrule/integrations' extract-failure-code.ts exactly; a change here must be
// mirrored there, and vice versa. The client tool-name maps stay in the hook,
// which canonicalises the name before it hands the outcome over.
//
// Latency budget: < 2ms per call on the PostToolUse hot path.
// All regex compiled once at module load.

const FAILURE_CODES = new Set([
  "exit_nonzero",
  "timeout",
  "file_not_found",
  "permission_denied",
  "rate_limit",
  "token_limit",
  "syntax_error",
  "unknown",
]);

const FAILURE_REGEX_BANK = [
  [
    "timeout",
    [
      /\bECONNABORTED\b/i,
      /\boperation timed out\b/i,
      /\bcommand timed out after \d+/i,
      /\btimed out\b/i,
      /\bDeadlineExceeded\b/i,
      /\bERR_SOCKET_TIMEOUT\b/i,
      /\bconnection timed out\b/i,
      /\bsocket hang up\b/i,
      /\bread timeout\b/i,
    ],
  ],
  [
    "file_not_found",
    [
      /\bENOENT\b/i,
      /\bNo such file or directory\b/i,
      /\bcannot find the file specified\b/i,
      /\bThe system cannot find the file\b/i,
      /\bFile not found\b/i,
      // Claude Code's own wording on a missing Read target:
      // "File does not exist. Note: your current working directory is …".
      // Keep in sync with extract-failure-code.ts — this bank is the standalone copy.
      /\bFile does not exist\b/i,
      /\bno such file\b/i,
      /\bpath does not exist\b/i,
      /\bfailed to open file\b/i,
      /\bFileNotFoundError\b/i,
    ],
  ],
  [
    "permission_denied",
    [
      /\bEACCES\b/i,
      /\bpermission denied\b/i,
      /\bOperation not permitted\b/i,
      /\bEPERM\b/i,
      /\bAccess is denied\b/i,
      /\bInsufficient permissions\b/i,
      /\bforbidden\b/i,
      /\bUnauthorized\b/i,
    ],
  ],
  [
    "rate_limit",
    [
      /\b429\b/i,
      /\brate.?limit(ed|ing)?\b/i,
      /\bToo Many Requests\b/i,
      /\bquota exceeded\b/i,
      /\bthrottle\b/i,
      /\bRetry-After\b/i,
      /\brateLimit\b/i,
    ],
  ],
  [
    "token_limit",
    [
      /\bcontext.{0,10}length.{0,10}exceed/i,
      /\btoken.{0,10}limit\b/i,
      /\bmax_tokens exceeded\b/i,
      /\bContext window\b/i,
      /\btoo long for model\b/i,
      /\binput too large\b/i,
      /\bmaximum context length\b/i,
      /\bcontext_length_exceeded\b/i,
    ],
  ],
  [
    "syntax_error",
    [
      /\bSyntaxError\b/i,
      /\bunexpected token\b/i,
      /\bparse error\b/i,
      /\bParseError\b/i,
      /\bInvalid JSON\b/i,
      /\bJSON\.parse\b/i,
      /\bunexpected end of input\b/i,
      /\billegal character\b/i,
      /\bunterminated string\b/i,
      /\bExpected.{0,30}but found\b/i,
    ],
  ],
];

function extractFailureCode(success, exitCode, stderr, signal, durationMs, timeoutThresholdMs) {
  if (success) return null;
  const haystack = stderr || "";
  for (const [code, regexes] of FAILURE_REGEX_BANK) {
    if (regexes.some((r) => r.test(haystack))) return code;
  }
  if (
    (signal === "SIGTERM" || signal === "SIGKILL") &&
    timeoutThresholdMs != null &&
    durationMs != null &&
    durationMs >= timeoutThresholdMs
  ) {
    return "timeout";
  }
  if (typeof exitCode === "number" && exitCode !== 0) return "exit_nonzero";
  return "unknown";
}

// ─── Bash exploration classifier ────────────────────────────────────────────
//
// This script ships standalone to ~/.pathrule/bin and cannot import from a package, so
// the classifier lives here.
//
// TELEMETRY ONLY. Nothing downstream of this may allow, deny, reorder or gate a tool
// call on its output. Most tool events of an agent session are shell commands that
// carry no file_path, so without this the exploration numbers would describe a small
// part of the work.
//
// Every ambiguity resolves to "unknown". An over-confident classification would report
// a wrong number; "unknown" only under-reports.
const BASH_MAX_COMMAND_CHARS = 4000;
const BASH_MAX_PATHS = 20;
const BASH_EXPLORATION_CMDS = new Set([
  "cat","bat","head","tail","nl","less","more","grep","egrep","fgrep","rg","ag","ack",
  "find","fd","ls","tree","wc","file","stat","diff","comm","cmp","du","readlink",
  "realpath","od","xxd","strings","jq","yq","column",
]);
const BASH_MUTATION_CMDS = new Set([
  "rm","mv","cp","mkdir","rmdir","touch","ln","chmod","chown","truncate","dd","tee",
  "patch","install","shred",
]);
const BASH_TEST_CMDS = new Set(["vitest","jest","pytest","mocha","ava","playwright","cypress","tap"]);
const BASH_EXECUTION_CMDS = new Set([
  "node","tsx","deno","bun","python","python3","ruby","php","java","go","cargo","make",
  "cmake","docker","tsc","eslint","prettier","curl","wget","echo","printf","sleep",
  "kill","open","code",
]);
const BASH_GIT_SUBS = {
  log:"exploration", show:"exploration", diff:"exploration", grep:"exploration",
  status:"exploration", blame:"exploration", "ls-files":"exploration",
  "rev-parse":"exploration", "show-ref":"exploration", describe:"exploration",
  shortlog:"exploration", "cat-file":"exploration", "diff-tree":"exploration",
  add:"mutation", commit:"mutation", checkout:"mutation", switch:"mutation",
  reset:"mutation", restore:"mutation", rm:"mutation", mv:"mutation", clean:"mutation",
  stash:"mutation", merge:"mutation", rebase:"mutation", apply:"mutation",
  push:"mutation", pull:"mutation", fetch:"mutation", cherry:"mutation",
  "cherry-pick":"mutation", tag:"mutation", init:"mutation", clone:"mutation",
  branch:"mutation", worktree:"mutation",
};
const BASH_PACKAGE_MANAGERS = new Set(["npm","pnpm","yarn","npx","pnpx"]);
const BASH_PATTERN_FIRST = new Set(["grep","egrep","fgrep","rg","ag","ack","sed","awk"]);
const BASH_WRAPPERS = new Set(["sudo","command","time","nohup","exec","env","nice"]);
const BASH_TOO_BROAD = new Set(["/",".","..","~","~/","*","**","./","../","-"]);

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

function bashLooksLikePath(token) {
  if (!token || token.length > 300) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("://")) return false;
  if (BASH_TOO_BROAD.has(token)) return false;
  // A glob is a shape, not a location, and cannot be matched against a route.
  if (/[*?[\]{}]/.test(token)) return false;
  if (token.includes("/")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

function bashTrimSlash(token) {
  return token.length > 1 && token.endsWith("/") ? token.slice(0, -1) : token;
}

function bashOperands(tokens, family) {
  let patternSkipped = !BASH_PATTERN_FIRST.has(family);
  const out = [];
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    if (!patternSkipped) { patternSkipped = true; continue; }
    if (bashLooksLikePath(token)) out.push(bashTrimSlash(token));
  }
  return out;
}

function bashClassifySegment(segment) {
  const tokens = bashTokenize(segment);
  if (tokens.length === 0) return { category: "unknown", family: null, observed: [], modified: [] };

  const modified = [];
  let redirects = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === ">" || t === ">>" || t === "1>" || t === "2>" || t === "&>") {
      redirects = true;
      const target = tokens[i + 1];
      if (target && bashLooksLikePath(target)) modified.push(bashTrimSlash(target));
      continue;
    }
    if (/^>{1,2}[^>]/.test(t)) {
      redirects = true;
      const target = t.replace(/^>{1,2}/, "");
      if (bashLooksLikePath(target)) modified.push(bashTrimSlash(target));
    }
  }

  let head = 0;
  while (head < tokens.length) {
    const t = tokens[head];
    if (BASH_WRAPPERS.has(bashBasename(t)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) head += 1;
    else break;
  }
  if (head >= tokens.length) return { category: "unknown", family: null, observed: [], modified };

  const family = bashBasename(tokens[head]);
  const rest = tokens.slice(head + 1);

  const finish = (category) => {
    if (redirects && category !== "unknown") return { category: "mutation", family, observed: [], modified };
    if (category === "exploration") return { category, family, observed: bashOperands(rest, family), modified };
    if (category === "mutation") return { category, family, observed: [], modified: modified.concat(bashOperands(rest, family)) };
    return { category, family, observed: [], modified };
  };

  if (family === "git") {
    const sub = rest.find((t) => !t.startsWith("-"));
    const mapped = sub ? BASH_GIT_SUBS[sub] : undefined;
    if (!mapped) return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
    if (mapped === "exploration") {
      if (redirects) return { category: "mutation", family, observed: [], modified };
      const after = rest.slice(rest.indexOf(sub) + 1);
      return { category: "exploration", family, observed: bashOperands(after, "git"), modified };
    }
    return { category: "mutation", family, observed: [], modified };
  }

  if (family === "sed") {
    const inPlace = rest.some((t) => t === "-i" || /^-i\S*$/.test(t) || t === "--in-place");
    return finish(inPlace ? "mutation" : "exploration");
  }

  if (family === "awk") {
    return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
  }

  if (BASH_PACKAGE_MANAGERS.has(family)) {
    const sub = rest.find((t) => !t.startsWith("-"));
    if (!sub) return { category: "unknown", family, observed: [], modified };
    if (sub === "test" || BASH_TEST_CMDS.has(sub)) return finish("test");
    if (sub === "install" || sub === "add" || sub === "remove" || sub === "uninstall" || sub === "ci") {
      return finish("mutation");
    }
    if (sub === "run" || sub === "exec" || sub === "dlx") {
      const script = rest[rest.indexOf(sub) + 1];
      if (script && (script === "test" || /(^|[:-])test([:-]|$)/.test(script))) return finish("test");
      return finish("execution");
    }
    return { category: "unknown", family, observed: [], modified };
  }

  if (BASH_TEST_CMDS.has(family)) return finish("test");
  if (BASH_EXPLORATION_CMDS.has(family)) return finish("exploration");
  if (BASH_MUTATION_CMDS.has(family)) return finish("mutation");
  if (BASH_EXECUTION_CMDS.has(family)) return finish("execution");
  return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
}

function bashDedupeCapped(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= BASH_MAX_PATHS) break;
  }
  return out;
}

function classifyBashCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return { category: "unknown", family: null, pathsObserved: [], pathsModified: [] };
  }
  const bounded =
    command.length > BASH_MAX_COMMAND_CHARS ? command.slice(0, BASH_MAX_COMMAND_CHARS) : command;
  const segments = bounded.split(/\n|&&|\|\||[;|]/g).map((s) => s.trim()).filter(Boolean);
  const results = segments.map(bashClassifySegment);

  let category = "exploration";
  if (results.length === 0) category = "unknown";
  else if (results.some((r) => r.category === "mutation")) category = "mutation";
  else if (results.some((r) => r.category === "unknown")) category = "unknown";
  else if (results.some((r) => r.category === "test")) category = "test";
  else if (results.some((r) => r.category === "execution")) category = "execution";

  const observed = [];
  const modified = [];
  let family = null;
  for (const r of results) {
    if (!family && r.family) family = r.family;
    for (const p of r.observed) observed.push(p);
    for (const p of r.modified) modified.push(p);
  }
  return {
    category,
    family,
    pathsObserved: bashDedupeCapped(observed),
    pathsModified: bashDedupeCapped(modified),
  };
}

// Does an observed path count as following a routed path? EXACT or DESCENDANT only.
// Ancestors deliberately do not count: `ls /` observes the ancestor of every route,
// and counting it would make route accuracy a measure of how often the agent ran `ls`.
function observedPathFollowsRoute(observed, routed) {
  if (!observed || !routed) return false;
  if (observed === "/" || routed === "/") return false;
  const o = bashTrimSlash(observed);
  const r = bashTrimSlash(routed);
  if (!o.startsWith("/") || !r.startsWith("/")) return false;
  return o === r || o.startsWith(r + "/");
}

// Session buffer — ON DISK, because this hook is a FRESH PROCESS on every event.
// See the header: it reads one payload from stdin and exits. A module-level Map is
// therefore constructed empty every single time, so anything accumulated in it dies
// before the next event fires — let alone before the MCP server tries to read it.
//
// A counter kept in such a Map would always read 0, and a counter that is always 0
// looks like a valid counter.
//
// So the counter is an append-only JSONL file per session, which a long-lived
// process can drain.
//
// One line per outcome, no read-modify-write: a single appendFileSync costs ~0.1ms
// and cannot interleave badly with another process appending its own whole line,
// which keeps PostToolUse off the hot path and preserves "never break the client".
// OUTCOMES_DIR = <CACHE_DIR>/tool-outcomes, bound in create().

// The session id arrives inside the client's hook payload, so it must never be
// able to escape the directory. Whitelist it. The consumer applies the IDENTICAL
// transform to find the same file — if you change this, change it there too.
function outcomeSessionFile(sessionId) {
  const safe = String(sessionId)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 120);
  return safe ? path.join(OUTCOMES_DIR, safe + ".jsonl") : null;
}

function appendToolOutcome(
  sessionId,
  toolName,
  success,
  failureCode,
  filePath,
  durationMs,
  client,
  exploration,
) {
  if (!sessionId) return;
  const file = outcomeSessionFile(sessionId);
  if (!file) return;
  try {
    const code =
      !success && failureCode && FAILURE_CODES.has(failureCode) ? failureCode : null;
    // Short keys: this line is written on every single tool call. The consumer maps
    // them back onto the ToolOutcome shape (and `cl` onto the client enum, where the
    // hook says "claude" and the enum says "claude-code").
    const record = {
      t: toolName,
      ok: success ? 1 : 0,
      c: code,
      f: filePath || null,
      d: typeof durationMs === "number" ? durationMs : null,
      cl: client || null,
      at: new Date().toISOString(),
    };
    // Exploration metadata. Only counts, categories and workspace-relative paths ever
    // land here: no command text, no output body, no environment values. Absent keys
    // mean "not known", which is why they are omitted rather than written as null.
    if (exploration) {
      if (exploration.category) record.cat = exploration.category;
      if (exploration.family) record.fam = exploration.family;
      if (exploration.pathsObserved && exploration.pathsObserved.length) {
        record.po = exploration.pathsObserved;
      }
      if (exploration.pathsModified && exploration.pathsModified.length) {
        record.pm = exploration.pathsModified;
      }
      if (typeof exploration.outputChars === "number" && exploration.outputChars > 0) {
        record.oc = exploration.outputChars;
      }
      // Verification fingerprint. A runner name, a script name and a workspace-relative
      // or package-name scope; never the command text and never an absolute path.
      if (exploration.verification) record.v = exploration.verification;
      // Versioned CHECK evidence has an explicit result independent of tool telemetry.
      if (exploration.verificationEvidence) {
        record.v2 = exploration.verificationEvidence;
        record.verificationOk = typeof exploration.verificationResult === "boolean" ? exploration.verificationResult : null;
      }
    }
    const line = JSON.stringify(record);
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    // Never break the hook on buffer errors.
  }
}

// Size of a tool result, in characters. SIZE ONLY: the body itself is never read into
// telemetry, never persisted and never sent anywhere. Tool count alone cannot tell
// `cat one-small-file.ts` apart from a command that returns a 200 KB log, and those two
// do not cost the same transcript.
function measureOutputChars(response, failureText) {
  try {
    if (typeof failureText === "string") return failureText.length;
    if (response == null) return 0;
    if (typeof response === "string") return response.length;
    if (typeof response === "object") {
      // Prefer the field that actually carries the payload; fall back to the whole
      // envelope so a shape we have not measured still yields a size rather than 0.
      for (const key of ["stdout", "content", "output", "text", "result"]) {
        const v = response[key];
        if (typeof v === "string") return v.length;
      }
      return JSON.stringify(response).length;
    }
    return 0;
  } catch {
    return 0;
  }
}

// Raw operands to workspace-relative paths, through the same normalizer files_touched
// uses. Anything outside the workspace drops out, which is also what keeps an absolute
// home-directory path from ever reaching telemetry.
function normalizeObservedPaths(rawPaths, workspaceRoot) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || !workspaceRoot) return [];
  const out = [];
  const seen = new Set();
  const rootPrefix = String(workspaceRoot).replace(/\/$/, "") + "/";
  for (const raw of rawPaths) {
    // An absolute path outside the workspace must never reach telemetry. The
    // normalizer's sibling-repo check catches most of them, but its fallback strips the
    // leading slash instead of rejecting, which would keep a home-directory path.
    // Home-relative operands are dropped for the same reason.
    if (typeof raw !== "string" || raw.startsWith("~")) continue;
    if (raw.startsWith("/") && !raw.startsWith(rootPrefix)) continue;
    let normalized = null;
    try {
      normalized = normalizeWorkspacePath(raw, workspaceRoot);
    } catch {
      normalized = null;
    }
    if (!normalized || normalized === "/" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= BASH_MAX_PATHS) break;
  }
  return out;
}

// Route follow-through for bash. The structured-tool path logs "followed" from
// PreToolUse; bash never had an equivalent, so a session that read every routed file
// through `cat` counted as having followed nothing.
//
// Runs at PostToolUse, off the latency-gated path, and writes state at most once per
// route (the flag short-circuits every later call).
function noteBashRouteFollow(observedPaths) {
  if (!Array.isArray(observedPaths) || observedPaths.length === 0) return;
  if (!sessionFile || !workspaceId) return;
  try {
    if (!fs.existsSync(sessionFile)) return;
    const state = readSessionState();
    if (state.route_followed_logged === true) return;
    const routed = Array.isArray(state.last_route_paths) ? state.last_route_paths : [];
    if (routed.length === 0) return;
    // Routed paths are node paths ("/packages/app"); normalizeWorkspacePath returns the
    // files_touched shape, which has no leading slash. Compare in the node shape.
    const hit = observedPaths.find((observed) =>
      routed.some((route) => observedPathFollowsRoute("/" + observed, route)),
    );
    if (!hit) return;
    state.route_followed_logged = true;
    writeSessionState(state);
    logNavigation(workspaceId, {
      t: "followed",
      session_id: sessionId,
      path: hit,
      // Which channel proved the follow. "followed" alone cannot separate "the agent
      // opened the file with Read" from "the agent read it through bash", and those
      // two have opposite implications for what the meter can see.
      via: "bash",
    });
  } catch {
    /* telemetry must never break the hook */
  }
}

const CODEX_PATCH_FILE_GLOBAL_RE = /\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*([^\n]+)/g;

// Local injection log: append-only JSONL in the workspace cache dir. Safe to fail
// silently — the agent must never see stderr or slowdown from this.
//
// Fields: decision ('deny' for a strict block, else null), rule_ids[], memory_ids[],
// skill_ids[]: which rules and knowledge each delivery carried.
function logInjection({
  workspaceId,
  sessionId,
  toolName,
  filePath,
  ruleCount,
  memoryCount,
  decision,
  ruleIds,
  memoryIds,
  skillIds,
  // Which delivery strategy carried each item.
  injectionStrategyBreakdown,
}) {
  if (!workspaceId) return;
  const normalizedSkillIds = Array.isArray(skillIds) ? skillIds : [];
  const hasCounts = ruleCount > 0 || memoryCount > 0 || normalizedSkillIds.length > 0;
  const hasDecision = typeof decision === "string" && decision.length > 0;
  if (!hasCounts && !hasDecision) return;
  try {
    const dir = path.join(CACHE_DIR, workspaceId);
    fs.mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        workspace_id: workspaceId,
        session_id: sessionId,
        tool_name: toolName,
        file_path: filePath ?? null,
        rule_count: ruleCount,
        memory_count: memoryCount,
        decision: hasDecision ? decision : null,
        rule_ids: Array.isArray(ruleIds) ? ruleIds : [],
        memory_ids: Array.isArray(memoryIds) ? memoryIds : [],
        skill_ids: normalizedSkillIds,
        // Strategy breakdown; an empty object when the hook reported none.
        injection_strategy_breakdown: injectionStrategyBreakdown || {},
        created_at: new Date().toISOString(),
      }) + "\n";
    fs.appendFileSync(path.join(dir, "injections.jsonl"), line);
  } catch {
    // ignore — injection log is best-effort; never block Claude.
  }
}

// Route telemetry: fire-and-forget JSONL. "emitted" when a route is injected;
// "followed" (once per route) when a later file tool actually touches a routed path.
// accuracy = followed/emitted.
// Route history lives OUTSIDE the per-workspace cache directory.
//
// It used to be `<CACHE_DIR>/<workspaceId>/navigation.jsonl`, next to rebuildable
// files. Route history is not rebuildable, and a cleanup of UUID-named cache
// directories that are not in the live workspace list would take it with them.
//
// `<CACHE_DIR>/navigation/` is not a UUID, so that cleanup skips it, as it skips
// `<CACHE_DIR>/tool-outcomes/`.
// NAVIGATION_DIR = <CACHE_DIR>/navigation, bound in create().

function navigationFileFor(workspaceId) {
  const safe = String(workspaceId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return safe ? path.join(NAVIGATION_DIR, safe + ".jsonl") : null;
}

// One-time carry-over of whatever survived at the legacy path. Append rather than
// rename: a rename would lose lines the new file already holds if both exist.
function migrateLegacyNavigation(workspaceId, target) {
  const legacy = path.join(CACHE_DIR, workspaceId, "navigation.jsonl");
  try {
    if (!fs.existsSync(legacy)) return;
    const carried = fs.readFileSync(legacy, "utf8");
    if (carried.trim()) {
      fs.appendFileSync(target, carried.endsWith("\n") ? carried : carried + "\n");
    }
    fs.unlinkSync(legacy);
  } catch {
    /* migration is best-effort; losing it must never break the hook */
  }
}

function logNavigation(workspaceId, record) {
  if (!workspaceId) return;
  try {
    const file = navigationFileFor(workspaceId);
    if (!file) return;
    fs.mkdirSync(NAVIGATION_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) migrateLegacyNavigation(workspaceId, file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    /* telemetry must never break the hook */
  }
}

// The CLOUD ranking call needs its own budget.
//
// The local BYO path embeds a query against a provider directly and 800 ms is generous for
// it. The cloud call embeds the prompt AND searches the hosted index, which takes longer;
// under an 800 ms ceiling it would fail every time, so the hook would pay the wait and then
// fall back to keyword overlap anyway.
const CLOUD_SEMANTIC_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.PATHRULE_CLOUD_SEMANTIC_TIMEOUT_MS ?? "", 10);
  // Headroom here is cheap: the breaker below makes a genuine outage cost one prompt, not
  // every prompt.
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 500), 8000) : 3500;
})();

// Session-level circuit breaker for the cloud call.
//
// A timeout is cheap to absorb once and expensive to repeat: an endpoint that is slow or
// unreachable would otherwise cost the full budget on every prompt for the life of the
// session, which is exactly the failure the 800 ms ceiling produced. After a timeout or a
// transport error the hook stops asking and stays on keyword overlap, and says so in the
// select outcome so the two situations remain distinguishable.
function cloudSemanticBreakerPath(wsId) {
  return path.join(CACHE_DIR, wsId, "cloud-semantic-breaker.json");
}
const CLOUD_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
function cloudSemanticTripped(wsId) {
  if (!wsId) return false;
  try {
    const at = JSON.parse(fs.readFileSync(cloudSemanticBreakerPath(wsId), "utf8"))?.at;
    return typeof at === "number" && Date.now() - at < CLOUD_BREAKER_COOLDOWN_MS;
  } catch {
    return false;
  }
}
function tripCloudSemantic(wsId) {
  if (!wsId) return;
  try {
    fs.mkdirSync(path.dirname(cloudSemanticBreakerPath(wsId)), { recursive: true });
    fs.writeFileSync(cloudSemanticBreakerPath(wsId), JSON.stringify({ at: Date.now() }), "utf8");
  } catch {
    /* best effort */
  }
}
// Cloud ranking env for the helper, or null when this is not a signed-in cloud
// index (the local edition writes no cloud_semantic block, which is the whole
// edition boundary: local brings its own key, cloud rides ours).
function cloudSemanticEnv(idx, routePath) {
  const cfg = idx && idx.cloud_semantic; // Pathrule Cloud: the helper reads its own session
  if (!cfg || cfg.kind !== "native" || !cfg.url || cloudSemanticTripped(idx.workspace_id)) return null;
  if (!fs.existsSync(path.join(PATHRULE_HOME, "native-session.json"))) return null;
  return {
    PATHRULE_CLOUD_SEMANTIC_URL: cfg.url,
    PATHRULE_CLOUD_SEMANTIC_WORKSPACE: String(idx.workspace_id ?? ""),
    // Deliberately EMPTY. A root path here narrows the search to that path, and a routed
    // file or folder would drop every candidate outside it. The candidate pool stays global
    // so a weak route cannot cause a miss; the path is weighed on the ranking side, through
    // the node_path the helper carries back. Global recall, local weighting — one job each.
    PATHRULE_CLOUD_SEMANTIC_ROOT_PATH: "",
    PATHRULE_CLOUD_SEMANTIC_LIMIT: String(SEMANTIC_INJECT_TOPK),
    PATHRULE_CLOUD_SEMANTIC_MIN_SIMILARITY: String(SEMANTIC_INJECT_MIN),
    // There are TWO budgets on this call: spawnSync's timeout below, and the helper's own
    // fetch abort. If the helper aborted first it would exit 1, which reads as an ERROR and
    // trips the breaker. Passing the number through makes it one budget with one owner.
    PATHRULE_CLOUD_SEMANTIC_TIMEOUT_MS: String(CLOUD_SEMANTIC_TIMEOUT_MS),
  };
}

// The hosted ranking call: the helper (cloud-semantic-query.cjs, next to the hook) embeds the prompt
// with Pathrule's key and searches the hosted index, so it answers with RANKED CANDIDATES rather than
// a vector. Cached per prompt within the process, so an identical re-prompt never re-spawns. Returns
// null when this is not a signed-in cloud index, and the hook then ranks locally. NEVER throws.
//
// PATHRULE_EMBED_HELPER overrides this helper too, exactly as it overrode the one helper both
// channels shared before they were split, so one deterministic stub still covers a whole test.
const promptVecCache = new Map();
function rankPrompt({ index: idx, text: prompt, limit, minSimilarity }) {
  SEMANTIC_INJECT_TOPK = limit;
  SEMANTIC_INJECT_MIN = minSimilarity;
  const cloudEnv = cloudSemanticEnv(idx, "");
  if (!cloudEnv) return null;
  const text = String(prompt ?? "").trim();
  if (text.length === 0) return { vec: null, candidates: null, outcome: "fallback_empty" };
  const key = crypto.createHash("sha256").update(`cloud\0${text}`).digest("hex").slice(0, 16);
  const cached = promptVecCache.get(key);
  if (cached) return cached;
  let result;
  try {
    const r = spawnSync(process.execPath, [CLOUD_SEMANTIC_HELPER_PATH], {
      input: text,
      timeout: CLOUD_SEMANTIC_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...cloudEnv },
    });
    if (r.error && r.error.code === "ETIMEDOUT") {
      tripCloudSemantic(cloudEnv.PATHRULE_CLOUD_SEMANTIC_WORKSPACE);
      result = { vec: null, candidates: null, outcome: "fallback_timeout" };
    } else if (r.status === 3) {
      result = { vec: null, candidates: null, outcome: "fallback_no_key" };
    } else if (r.status !== 0) {
      tripCloudSemantic(cloudEnv.PATHRULE_CLOUD_SEMANTIC_WORKSPACE);
      result = { vec: null, candidates: null, outcome: "fallback_cloud_error" };
    } else {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed.candidates)) {
        // The server applied the floor, so an EMPTY list is a real verdict ("nothing is
        // relevant"), not a failure. It is reported separately from
        // an error so the two can never be confused.
        result = {
          vec: null,
          candidates: parsed.candidates,
          outcome: parsed.candidates.length > 0 ? "hit_cloud" : "cloud_below_threshold",
        };
      } else if (Array.isArray(parsed.embedding) && parsed.embedding.length > 0) {
        result = { vec: parsed.embedding, candidates: null, outcome: "hit" };
      } else {
        result = { vec: null, candidates: null, outcome: "fallback_error" };
      }
    }
  } catch {
    result = { vec: null, candidates: null, outcome: "fallback_cloud_error" };
  }
  promptVecCache.set(key, result);
  return result;
}

// ─── Work-state conflict check ───────────────────────────────────────────────

function extractWriteRelativePaths(input) {
  const paths = [];
  const addPath = (candidate) => {
    if (typeof candidate !== "string" || candidate.trim() === "") return;
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
    // Route through the canonical normalizer so every writer produces identical
    // workspace-relative POSIX paths. Falls back to toRelative() if the normalizer
    // returns null (e.g. a path outside the workspace).
    const normalized = normalizeWorkspacePath(absolute, index.workspace_root);
    if (normalized) {
      paths.push(normalized);
      return;
    }
    // Fallback: toRelative strips the workspace root but lacks the normalizer's guards.
    const rel = toRelative(absolute, index.workspace_root);
    const workStateRel = rel && rel !== "/" ? rel.replace(/^\/+/, "") : null;
    if (workStateRel) paths.push(workStateRel);
  };

  if (toolName === "Edit" || toolName === "Write") addPath(input.file_path);

  if (clientShape === "codex" && typeof input.command === "string") {
    for (const match of input.command.matchAll(CODEX_PATCH_FILE_GLOBAL_RE)) {
      addPath(match[1] ? match[1].trim() : "");
    }
  }

  if (toolName === "Bash" && typeof input.command === "string") {
    for (const rel of extractBashWritePathCandidates(input.command)) addPath(rel);
  }

  return Array.from(new Set(paths)).slice(0, 100);
}

function extractBashWritePathCandidates(command) {
  const candidates = [];
  const patterns = [
    /(?:^|[\s;&|])(?:cat|printf|echo)\b[^;&|]*>\s*(['"]?)([^'"\s;&|]+)\1/g,
    /(?:^|[\s;&|])tee(?:\s+-a)?\s+(['"]?)([^'"\s;&|]+)\1/g,
    /(?:^|[\s;&|])sed\s+-i(?:\s+['"][^'"]*['"])?\s+(['"]?)([^'"\s;&|]+)\1/g,
    /(?:^|[\s;&|])(?:rm|mv)\b(?:\s+-[A-Za-z]+)*\s+(['"]?)([^'"\s;&|]+)\1/g,
    /(?:^|[\s;&|])git\s+(?:restore|checkout\s+--)\s+(['"]?)([^'"\s;&|]+)\1/g,
  ];
  for (const re of patterns) {
    for (const match of command.matchAll(re)) {
      if (match[2]) candidates.push(match[2]);
    }
  }
  return candidates;
}

// Teammates' work state has no source on this machine (no local writer answers and no
// snapshot is kept), so nothing can complete the check. Returns true when there was a
// write to check: "degraded", which never interrupts a write.
async function askOnWorkConflict(relativePaths) {
  return relativePaths.length > 0;
}

// A shell command's exploration metadata: what it read and wrote, workspace-relative. Notes a
// route follow-through on the way. Telemetry only: nothing reads this to decide about the tool.
function exploreBash(command) {
  const classified = classifyBashCommand(command);
  const outcomeRoot = index && index.workspace_root ? index.workspace_root : null;
  const pathsObserved = normalizeObservedPaths(classified.pathsObserved, outcomeRoot);
  const pathsModified = normalizeObservedPaths(classified.pathsModified, outcomeRoot);
  noteBashRouteFollow(pathsObserved);
  return { category: classified.category, family: classified.family, pathsObserved, pathsModified };
}

// Record a completed tool call into the session buffer: success and failure alike. The hook
// canonicalises the tool name, classifies a shell command's exploration (exploreBash) and its
// verification fingerprint, and hands both over.
function recordToolOutcome({ response, failureText, isError, canonicalTool, exploration, verification, verificationEvidence, verificationResult }) {
  const outcomeSuccess = !isError;
  // On a failure event the text lives in event.error, not tool_response.stderr.
  const outcomeStderr = failureText || (response && (response.stderr || null)) || null;
  const outcomeExitCode =
    response && typeof response.exit_code === "number" ? response.exit_code : null;
  const outcomeSignal = response && typeof response.signal === "string" ? response.signal : null;
  // duration_ms is a TOP-LEVEL field on both Claude Code events (PostToolUse and
  // PostToolUseFailure). Reading it only from tool_response always produced null, which
  // disabled the signal-based timeout heuristic.
  const outcomeDurationMs =
    typeof event.duration_ms === "number"
      ? event.duration_ms
      : response && typeof response.duration_ms === "number"
        ? response.duration_ms
        : null;
  const outcomeFailureCode = extractFailureCode(
    outcomeSuccess,
    outcomeExitCode,
    outcomeStderr,
    outcomeSignal,
    outcomeDurationMs,
    120000,
  );
  const outcomeToolName = canonicalTool;
  const outcomeInput =
    event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  let outcomeFilePath = null;
  if (
    toolName === "Read" ||
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "read_file" ||
    toolName === "edit_file" ||
    toolName === "write_file" ||
    toolName === "view_file" ||
    toolName === "write_to_file"
    // NOT apply_patch: the hook's Codex branch already rewrote that event to `Edit` and
    // parsed the file out of the patch body, so a case for it here would be dead.
  ) {
    const outcomeRawPath =
      typeof outcomeInput.file_path === "string"
        ? outcomeInput.file_path
        : typeof outcomeInput.path === "string"
          ? outcomeInput.path
          : null;
    // Store the WORKSPACE-RELATIVE path, never the absolute one. Two reasons, both
    // load-bearing:
    //   1. Privacy — an absolute path on this machine names the person's home directory.
    //   2. Grouping — the same file on two machines under two home directories would
    //      never group.
    // normalizeWorkspacePath is the same normalizer files_touched uses, so an outcome
    // and an activity row name a file identically.
    const outcomeRoot = index && index.workspace_root ? index.workspace_root : null;
    outcomeFilePath = outcomeRoot && outcomeRawPath ? normalizeWorkspacePath(outcomeRawPath, outcomeRoot) : null;
  }
  // Exploration metadata. Shell commands are most of an agent's tool calls and carry
  // no file_path, so without this most of the exploration surface is invisible.
  const outcomeExploration = { outputChars: measureOutputChars(response, failureText) };
  if (outcomeToolName === "bash") {
    if (exploration) Object.assign(outcomeExploration, exploration);
    outcomeExploration.verification = verification;
    outcomeExploration.verificationEvidence = verificationEvidence;
    outcomeExploration.verificationResult = verificationResult;
  }
  appendToolOutcome(
    sessionId,
    outcomeToolName,
    outcomeSuccess,
    outcomeFailureCode,
    outcomeFilePath,
    outcomeDurationMs,
    clientShape,
    outcomeExploration,
  );
}

// A file tool touched a path the last route named: log "followed" once per route.
// accuracy = followed/emitted.
function noteRouteFollow(state, rel) {
  if (
    state.route_followed_logged !== true &&
    Array.isArray(state.last_route_paths) &&
    state.last_route_paths.some(
      (p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`),
    )
  ) {
    state.route_followed_logged = true;
    // `via` separates the two channels a follow can arrive through. Without it a low
    // route_accuracy cannot be told apart from a client whose reads never produce a
    // file_path, and those two have opposite fixes.
    logNavigation(workspaceId, { t: "followed", session_id: sessionId, path: rel, via: "file_tool" });
  }
}

function create(host) {
  PATHRULE_HOME = host.pathruleHome;
  CACHE_DIR = host.cacheDir;
  OUTCOMES_DIR = path.join(CACHE_DIR, "tool-outcomes");
  NAVIGATION_DIR = path.join(CACHE_DIR, "navigation");
  CLOUD_SEMANTIC_HELPER_PATH =
    process.env.PATHRULE_EMBED_HELPER && process.env.PATHRULE_EMBED_HELPER.trim() !== ""
      ? process.env.PATHRULE_EMBED_HELPER
      : path.join(host.binDir, "cloud-semantic-query.cjs");
  ({ event, eventName, toolName, cwd, sessionId, sessionFile, clientShape, index, workspaceId } = host);
  ({ logLatency, emit, emitEmpty, readSessionState, writeSessionState, toRelative } = host);
  normalizeWorkspacePath = host.normalizePath;
  return {
    rankPrompt,
    askOnWorkConflict: (input) => askOnWorkConflict(extractWriteRelativePaths(input)),
    exploreBash,
    recordToolOutcome,
    noteRouteFollow,
    logNavigation,
    logInjection,
  };
}

module.exports = { contract: HOOK_EXTENSION_CONTRACT, create };
