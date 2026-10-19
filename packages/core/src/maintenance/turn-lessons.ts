// SPDX-License-Identifier: Apache-2.0
/**
 * Lessons from a turn's own commands, with no model: a command failed, and a variant of it (the same
 * program and arguments, with an environment variable or a flag added) worked later in the session.
 * That variant is what the next session would otherwise rediscover, so it is saved at the workspace
 * root, which every session reads from the start.
 *
 * Measured on PathruleBench v2 (2026-10-15): agents met "the team suite needs ACME_TEAM_SUITE=1" in
 * every session, because a pipe (`... | tail`) hid the exit code from the hook and the agent did not
 * save what it learned. Read from the transcripts, the rule found the lesson in 46 of 57 chains; what
 * else it found was mostly inspection commands (`git diff`, `grep`), which are excluded below.
 *
 * Structural, so it reads every project and language the same way: what is compared is the command's
 * shape and the output's failure markers, never the person's words.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { captureGroundedAtom, type CapturedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";

/** The hook appends `{ sid, transcript }` here when a turn ends. */
export const ENDED_TURNS_LEDGER = "ended-turns.jsonl";

const FAILED_OUTPUT =
  /(^|\n)\s*(panic:|FAIL\b|Traceback \(most recent call last\)|Error:|ERROR\b|error\[|npm ERR!|not ok \d|✖ failing tests|ℹ fail [1-9]|# fail [1-9])|exit code [1-9]/i;
const PASSED = /(^|\n)(ok\s|PASS\b|=+ \d+ passed|# pass \d+|Tests?:\s+\d+ passed)/i;

/** Where the last match starts, or -1: a failure counts unless a pass marker comes after it. */
function lastIndex(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let at = -1;
  for (let m = g.exec(text); m; m = g.exec(text)) {
    at = m.index;
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return at;
}
const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=\S*$/;
/**
 * Flags that are no lesson: an agent adds them to see more, to look at something else, or to get past a
 * failure by not running it. "Needs --ignore=tests/team" would teach the next agent to skip the tests.
 */
const NOT_A_LESSON = /^(-v+|--verbose|-race|-count(=\d+)?|-run|-x|-n\d*|-p|-s|-q|-l|-rh|-U\d*|--check|--reporter.*|-k|--tb.*|--ignore.*|--deselect.*|-skip.*|--skip.*|--version|--help|--name-only|--fix|-t|--testNamePattern.*|--write|--json|-|--)$/;
/** Programs an agent runs to look, not to build or test: what they need is not a lesson. */
const INSPECTION = new Set(["git", "grep", "rg", "tail", "head", "cat", "ls", "sed", "find", "mv", "cp", "echo", "diff", "gofmt", "wc", "awk", "sort", "printf", "test", "["]);
/**
 * Words that run the next word as the program (`command grep …`, `time go test …`): read past them, or an
 * inspection command passes as a program of its own. `env` also sets variables, which are kept.
 */
const WRAPPERS = new Set(["command", "builtin", "exec", "time", "nohup", "sudo", "env"]);
/** Shell builtins: they run no program, so what they "need" is the shell's state, not a lesson. */
const BUILTINS = new Set(["export", "unset", "set", "source", ".", "alias", "unalias", "declare", "local", "readonly", "typeset", "eval", "read", "shift", "return", "exit", "trap", "ulimit", "umask", "wait", "true", "false", ":"]);
/** How far after the failure the variant may come, in commands. */
const WINDOW = 12;

export interface TurnLesson {
  /** The command family: program and its first two words (`go test ./acmetest`). */
  family: string;
  failed: string;
  worked: string;
  /** What the working variant added: environment assignments, then the directory it ran in, then flags. */
  added: string[];
  /**
   * The failing output's last line, as evidence, when the failing command was the call's last one; empty
   * otherwise. One Bash call's output belongs to all its commands, and its last line to the last command:
   * `go test ./...; (cd tools && go run ./checkdocs)` ends with "checkdocs: ok", which is no evidence
   * about go test (PathruleBench go-capability, 2026-10-18).
   */
  error: string;
}

interface Segment {
  env: string[];
  /** The command as written, a `-C <dir>` included. */
  words: string[];
  /** The command without a `-C <dir>`: what its flags are read from. */
  bare: string[];
  /** Its family words with path arguments read from the session's directory, so a command run from a
   *  subfolder (`cd tools && go run ./checkdocs`) compares equal to the same command run from the top
   *  (`go run ./tools/checkdocs`). */
  key: string[];
  /** Where it ran, relative to the session's directory: "" at the top, null when it cannot be told. */
  dir: string | null;
  /** How a directory other than the top was reached: a `cd` before it, or its own `-C <dir>`. */
  via: "cd" | "-C" | null;
  /** The call's last command, whose output ends the call's output. */
  last: boolean;
  /** Whether its family names a path, which is what a directory changes the meaning of. */
  pathed: boolean;
}

/** Programs whose `-C <dir>` runs them in that directory (in grep or ls, -C is something else). */
const DIRECTORY_FLAG = new Set(["go", "make", "git", "tar"]);
/** A word read as a path: it starts with ./ or ../, has a slash, or ends in a file extension. */
const PATH_WORD = /^\.{1,2}\/|\/|\.[A-Za-z0-9]{1,8}$/;

function split(part: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(part); m; m = re.exec(part)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** `rel` read from `base`, both relative to the session's directory; null when it leaves that directory. */
function joinPath(base: string, rel: string): string | null {
  const out = base ? base.split("/") : [];
  for (const p of rel.split("/")) {
    if (!p || p === ".") continue;
    if (p !== "..") out.push(p);
    else if (out.length === 0) return null;
    else out.pop();
  }
  return out.join("/");
}

/** Where `cd <target>` leads from `dir`; null when it cannot be told (`cd -`, `cd ~`, a variable, another tree). */
function cdTarget(dir: string | null, target: string, cwd: string | null): string | null {
  if (!target || /^[~$-]/.test(target)) return null;
  if (target.startsWith("/")) {
    if (!cwd) return null;
    const top = cwd.replace(/\/+$/, "");
    if (target.replace(/\/+$/, "") === top) return "";
    return target.startsWith(`${top}/`) ? joinPath("", target.slice(top.length + 1)) : null;
  }
  return dir === null ? null : joinPath(dir, target);
}

/** The command without its here-documents' bodies: the lines a `<<TAG` feeds a program are its input, not commands. */
function withoutHeredocs(cmd: string): string {
  const out: string[] = [];
  let tag: string | null = null;
  for (const line of cmd.split("\n")) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    out.push(line);
    tag = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)?.[1] ?? null;
  }
  return out.join("\n");
}

/**
 * Each `;`/`&&`-separated piece, cut at its first pipe, without env assignments or redirections, with
 * the directory it ran in. A `cd` is followed rather than dropped, and a subshell's `cd` ends with it.
 */
function segments(cmd: string, cwd: string | null = null): Segment[] {
  const out: Segment[] = [];
  const parts = withoutHeredocs(cmd).split(/\s*(?:;|&&|\|\||\n)\s*/).map((p) => p.trim());
  let lastPart = parts.length - 1;
  while (lastPart > 0 && !parts[lastPart]) lastPart--;
  let dir: string | null = "";
  const outer: Array<string | null> = [];
  parts.forEach((raw, i) => {
    const opens = raw.match(/^\(+/)?.[0].length ?? 0;
    const closes = raw.match(/\)+$/)?.[0].length ?? 0;
    for (let k = 0; k < opens; k++) outer.push(dir);
    const part = raw.slice(opens).split("|")[0]!.replace(/\)+$/, "").trim();
    if (part === "cd" || part.startsWith("cd ")) {
      dir = cdTarget(dir, split(part)[1] ?? "", cwd);
    } else if (part && !/\$\(|`/.test(part)) {
      // A command substitution is not read: the splitter cannot tell its words from the command's.
      const toks = unwrapped(split(part));
      const env = toks.filter((t) => ENV_ASSIGNMENT.test(t));
      const words = toks.filter((t) => !ENV_ASSIGNMENT.test(t) && !/^(\d?>&?\d?|2>&1|>.*|<.*)$/.test(t));
      let at: string | null = dir;
      let via: Segment["via"] = dir ? "cd" : null;
      let bare = words;
      const c = words.indexOf("-C");
      if (DIRECTORY_FLAG.has(words[0] ?? "") && c > 0 && words[c + 1]) {
        at = at === null ? null : joinPath(at, words[c + 1]!);
        via = "-C";
        bare = [...words.slice(0, c), ...words.slice(c + 2)];
      }
      const fam = family(bare);
      const key = fam.map((w) => (PATH_WORD.test(w) ? (joinPath(at ?? "", w) ?? w) : w));
      const pathed = fam.slice(1).some((w) => PATH_WORD.test(w));
      // A builtin runs no program, and a family naming a shell variable (`$W/run.py`) means nothing to
      // the next session: neither is a lesson to keep.
      const teachable = !BUILTINS.has(words[0] ?? "") && !fam.some((w) => w.includes("$"));
      if (words.length > 0 && teachable) out.push({ env, words, bare, key, dir: at, via: at ? via : null, last: i === lastPart, pathed });
    }
    for (let k = 0; k < closes && outer.length > 0; k++) dir = outer.pop()!;
  });
  return out;
}

/** The words with leading wrappers read past: `command grep x` is grep, `env A=1 go test` is go test with A=1. */
function unwrapped(toks: string[]): string[] {
  const out = [...toks];
  let i = 0;
  while (i < out.length && ENV_ASSIGNMENT.test(out[i]!)) i++;
  while (i < out.length && WRAPPERS.has(out[i]!)) {
    const wrapper = out.splice(i, 1)[0];
    while (i < out.length && out[i]!.startsWith("-")) out.splice(i, wrapper === "env" && out[i] === "-u" ? 2 : 1);
    while (i < out.length && ENV_ASSIGNMENT.test(out[i]!)) i++;
  }
  return out;
}

function family(words: string[]): string[] {
  return words.filter((w) => !w.startsWith("-")).slice(0, 3);
}

/** The directory step a working variant added, as the next agent would write it. */
function directoryStep(s: Segment): string {
  if (s.via !== "-C") return `cd ${s.dir}`;
  const c = s.words.indexOf("-C");
  return `-C ${s.words[c + 1]}`;
}

/** How a segment is rendered back: its `cd` first, then its environment and words. */
function rendered(s: Segment): string {
  return [...(s.via === "cd" ? [`cd ${s.dir} &&`] : []), ...s.env, ...s.words].join(" ");
}

interface CommandRun {
  cmd: string;
  failed: boolean;
  tail: string;
}

/** The session's working directory, which Claude Code stamps on its transcript entries; null when absent. */
function sessionCwd(transcript: string): string | null {
  for (const line of transcript.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
    } catch {
      // a torn line
    }
  }
  return null;
}

/** The Bash commands of a Claude Code transcript (JSONL), in order, with whether each failed. */
export function commandRuns(transcript: string): CommandRun[] {
  const calls: Array<{ id: string; cmd: string }> = [];
  const results = new Map<string, { error: boolean; text: string }>();
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    const content = Array.isArray(e.message?.content) ? (e.message!.content as Array<Record<string, unknown>>) : [];
    if (e.type === "assistant") {
      for (const b of content) {
        const input = b.input as { command?: unknown } | undefined;
        if (b.type === "tool_use" && b.name === "Bash" && typeof input?.command === "string") calls.push({ id: String(b.id), cmd: input.command });
      }
    } else if (e.type === "user") {
      for (const b of content) {
        if (b.type !== "tool_result") continue;
        const c = b.content;
        const raw = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x?.text ?? "").join("\n") : "";
        // Claude Code's own note after a call is not the command's output, and never its evidence.
        const text = raw.replace(/\n?Shell cwd was reset to [^\n]*\s*$/, "");
        results.set(String(b.tool_use_id), { error: b.is_error === true, text });
      }
    }
  }
  return calls.map(({ id, cmd }) => {
    const r = results.get(id) ?? { error: false, text: "" };
    const failed = r.error || lastIndex(FAILED_OUTPUT, r.text) > lastIndex(PASSED, r.text);
    return { cmd, failed, tail: r.text.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "" };
  });
}

/** Failure -> recovery pairs in one transcript, one per command family and what was added. */
export function turnLessons(transcript: string): TurnLesson[] {
  const runs = commandRuns(transcript);
  const cwd = sessionCwd(transcript);
  const out = new Map<string, TurnLesson>();
  runs.forEach((a, i) => {
    if (!a.failed) return;
    for (const sa of segments(a.cmd, cwd)) {
      const fam = family(sa.bare);
      // A command run outside the session's folder (`cd /other/tree && …`), or somewhere that cannot be
      // told, teaches nothing about this project: its lesson would land in a workspace it is not about.
      if (fam.length < 2 || INSPECTION.has(fam[0]!) || sa.dir === null) continue;
      for (const b of runs.slice(i + 1, i + 1 + WINDOW)) {
        if (b.failed) continue;
        const sb = segments(b.cmd, cwd).find((s) => s.key.join(" ") === sa.key.join(" "));
        if (!sb) continue;
        const addedEnv = sb.env.filter((t) => !sa.env.includes(t)).sort();
        // A directory is a lesson only for a command that names a path it changes the meaning of, and that
        // ended its failing call, so the failure was its own.
        const addedDir = sb.dir && sa.dir !== null && sb.dir !== sa.dir && sb.pathed && sa.last ? [directoryStep(sb)] : [];
        const before = new Set(sa.bare.filter((w) => w.startsWith("-")));
        const addedFlags = [...new Set(sb.bare.filter((w) => w.startsWith("-") && !before.has(w) && !NOT_A_LESSON.test(w)))].sort();
        const added = [...addedEnv, ...addedDir, ...addedFlags];
        if (added.length === 0) continue;
        const key = `${fam.join(" ")}\u0000${added.join(" ")}`;
        if (!out.has(key)) out.set(key, { family: fam.join(" "), failed: rendered(sa), worked: rendered(sb), added, error: sa.last ? a.tail : "" });
        break;
      }
    }
  });
  return [...out.values()];
}

/** The memory a lesson becomes. Its first paragraph is the instruction, typed as one fact. */
export function lessonMemory(l: TurnLesson): { title: string; content: string } {
  const what = l.added.map((a) => `\`${a}\``).join(" and ");
  const rule = `Running \`${l.family}\` here needs ${what}: it failed without ${l.added.length > 1 ? "them" : "it"} and worked as \`${l.worked}\`.`;
  return {
    title: `How to run ${l.family}`,
    content: l.error ? `${rule}\n\nThe failure: \`${l.error.replace(/`/g, "'")}\`` : rule,
  };
}

type LessonStore = Pick<KnowledgeBackend, "listMemories" | "ensureNodeForPath" | "writeMemory"> & {
  recordGroundedAtom?: (workspaceId: string, atom: CapturedAtom) => Promise<unknown>;
};

/**
 * Read the transcripts of turns that ended since the last pass, and save each new lesson at `/` with
 * its rule typed, so the binding files carry it. A lesson whose title is already at the root is not
 * saved again. Returns how many were saved; the ledger is consumed either way.
 */
export async function learnFromEndedTurns(store: LessonStore, workspaceId: string, cacheDir: string, now = new Date().toISOString()): Promise<number> {
  const ledger = join(cacheDir, ENDED_TURNS_LEDGER);
  if (!existsSync(ledger)) return 0;
  const consumed = `${ledger}.consumed`;
  try {
    renameSync(ledger, consumed);
  } catch {
    return 0;
  }
  const transcripts = new Set<string>();
  for (const line of readFileSync(consumed, "utf8").split("\n")) {
    try {
      const t = (JSON.parse(line) as { transcript?: unknown }).transcript;
      if (typeof t === "string" && t) transcripts.add(t);
    } catch {
      // a torn line
    }
  }
  const lessons = new Map<string, TurnLesson>();
  for (const t of transcripts) {
    let text = "";
    try {
      text = readFileSync(t, "utf8");
    } catch {
      continue;
    }
    for (const l of turnLessons(text)) lessons.set(lessonMemory(l).title, l);
  }
  if (lessons.size === 0) return 0;
  const root = await store.ensureNodeForPath(workspaceId, "/", "folder");
  const titles = new Set((await store.listMemories({ workspaceId, nodeId: root.id })).map((m) => m.title));
  let saved = 0;
  for (const l of lessons.values()) {
    const { title, content } = lessonMemory(l);
    if (titles.has(title)) continue;
    const m = await store.writeMemory({ workspaceId, nodeId: root.id, title, content, source: "claude" });
    titles.add(title);
    saved += 1;
    if (store.recordGroundedAtom) {
      const fact = content.split("\n\n")[0]!;
      const c = captureGroundedAtom({ kind: "context", fact: [fact] }, { kind: "memory", id: m.id, title, content }, now);
      if (c.ok) await store.recordGroundedAtom(workspaceId, c.atom);
    }
  }
  return saved;
}
