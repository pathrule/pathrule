// SPDX-License-Identifier: Apache-2.0
// The friction classifier, tested on the code that actually runs.
//
// WHY THIS FILE REPLACED THE ADAPTER TESTS. The TypeScript post-tool-use layer
// (router + five client adapters) had no caller anywhere in the product: the only live
// producer is the inlined copy inside pathrule-hook.js, because that script ships
// standalone to ~/.pathrule/bin and cannot import from the package. So the adapter suite
// was green for months while the real path recorded nothing, and its fixtures were
// written from documented shapes that turned out not to match what Claude Code sends.
// A test that cannot fail when production breaks is not a test.
//
// This one runs the hook as a child process against the MEASURED payload shapes and
// asserts the JSONL line the drain will later read. It also pins the hook's inline regex
// bank to `extract-failure-code.ts` behaviourally — same inputs, same code — which is
// what keeps the two banks in sync now that a comment is no longer the only guard.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { extractFailureCode } from "@pathrule/integrations/hook-supervisor/extract-failure-code.js";

// The open hook, with the extensions this behaviour needs beside it, the way the official build installs them.
const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const CLOUD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook-cloud.cjs");
const WS_ID = "55555555-5555-5555-5555-555555555555";
/** Same threshold the hook passes at its call site. */
const HOOK_TIMEOUT_THRESHOLD_MS = 120_000;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

interface Harness {
  home: string;
  hookScript: string;
  wsRoot: string;
}

async function makeHome(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-friction-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await copyFile(CLOUD_EXTENSION, join(dirname(hookScript), "pathrule-hook-cloud.cjs"));

  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "packages", "app"), { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-08-22T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
      indexed_memory_ids: [],
      path_memories: {},
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      path_skills: {},
      work_episode_index: [],
    }),
  );
  return { home, hookScript, wsRoot };
}

function runEvent(h: Harness, event: Record<string, unknown>, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: h.home,
          PATHRULE_HOOK_EVENT: String(event["hook_event_name"] ?? "PostToolUse"),
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        resolve();
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: h.wsRoot, session_id: sessionId, ...event }));
  });
}

interface OutcomeLine {
  t: string;
  ok: 0 | 1;
  c: string | null;
  f: string | null;
  d: number | null;
  cl: string;
  at: string;
}

async function readOutcomes(home: string, sessionId: string): Promise<OutcomeLine[]> {
  const file = join(home, "cache", "tool-outcomes", `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as OutcomeLine);
}

// ── The payload shapes, as MEASURED from Claude Code on 2026-08-22 ────────────────
//
// A successful tool arrives as PostToolUse with a tool_response object and a TOP-LEVEL
// duration_ms. A FAILED tool arrives as a different event, PostToolUseFailure, with NO
// tool_response at all: the message is a top-level `error` string. The hook was handed
// only the successes for its whole life, which is why tool_failure_codes was empty in
// every month of prod data.

describe("the hook classifies the measured Claude Code payloads", () => {
  it("PostToolUseFailure on a missing Read: file_not_found, workspace-relative path, duration", async () => {
    const h = await makeHome();
    await runEvent(
      h,
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Read",
        tool_input: { file_path: join(h.wsRoot, "packages/app/missing.ts") },
        error:
          "File does not exist. Note: your current working directory is /Users/someone/project",
        is_interrupt: false,
        duration_ms: 4,
      },
      "sess-fail",
    );

    const lines = await readOutcomes(h.home, "sess-fail");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      t: "read",
      ok: 0,
      c: "file_not_found",
      // Never the absolute path: it would leak a home directory to the cloud and would
      // never group across two machines in the hotspot view.
      f: "packages/app/missing.ts",
      d: 4,
    });
  });

  it("PostToolUse on a successful Bash: recorded as a call, no failure code", async () => {
    const h = await makeHome();
    await runEvent(
      h,
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: {
          stdout: "file.ts",
          stderr: "",
          interrupted: false,
          isImage: false,
        },
        duration_ms: 84,
      },
      "sess-ok",
    );

    const lines = await readOutcomes(h.home, "sess-ok");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ t: "bash", ok: 1, c: null, d: 84 });
  });

  it("reads duration_ms from the TOP LEVEL — reading it off tool_response yielded null forever", async () => {
    const h = await makeHome();
    await runEvent(
      h,
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep 1" },
        // Deliberately NOT carrying duration_ms inside tool_response: that is the shape
        // the old fixtures assumed, and it is why the timeout heuristic was dead.
        tool_response: { stdout: "", stderr: "", interrupted: false },
        duration_ms: 1234,
      },
      "sess-duration",
    );

    const [line] = await readOutcomes(h.home, "sess-duration");
    expect(line?.d).toBe(1234);
  });

  it("treats interrupted:true as a failure — it is the one failure signal PostToolUse carries", async () => {
    const h = await makeHome();
    await runEvent(
      h,
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "sleep 600" },
        tool_response: { stdout: "", stderr: "", interrupted: true },
        duration_ms: 130_000,
      },
      "sess-interrupt",
    );

    const [line] = await readOutcomes(h.home, "sess-interrupt");
    expect(line?.ok).toBe(0);
    expect(line?.c).toBeTruthy();
  });
});

// ── Behavioural parity: the hook's inline bank vs the TS bank ─────────────────────
//
// The two banks are separate copies by necessity (the hook ships standalone). Until now
// only a comment asked future editors to keep them in sync. These cases make the request
// enforceable: identical input, identical classification.

const PARITY_CASES: Array<{ name: string; stderr: string; expected: string }> = [
  { name: "ENOENT", stderr: "Error: ENOENT: no such file or directory", expected: "file_not_found" },
  {
    name: "Claude Code's own missing-file wording",
    stderr: "File does not exist. Note: your current working directory is /x",
    expected: "file_not_found",
  },
  { name: "EACCES", stderr: "EACCES: permission denied, open '/etc/hosts'", expected: "permission_denied" },
  { name: "HTTP 429", stderr: "Request failed with status 429 Too Many Requests", expected: "rate_limit" },
  { name: "timeout wording", stderr: "command timed out after 120000ms", expected: "timeout" },
  { name: "unrecognised text", stderr: "the frobnicator disagreed", expected: "unknown" },
  {
    name: "a SQL error must NOT be read as a missing file",
    // This is why the bank carries `File does not exist` and not a generic
    // `does not exist`: Postgres says "column x does not exist".
    stderr: 'ERROR: column "foo" does not exist',
    expected: "unknown",
  },
];

describe("the inline hook bank and extract-failure-code.ts classify identically", () => {
  for (const kase of PARITY_CASES) {
    it(`${kase.name} → ${kase.expected}`, async () => {
      const fromTs = extractFailureCode({
        success: false,
        exit_code: null,
        stderr: kase.stderr,
        signal: null,
        duration_ms: null,
        timeout_threshold_ms: HOOK_TIMEOUT_THRESHOLD_MS,
      });

      const h = await makeHome();
      const session = `sess-parity-${kase.expected}-${kase.name.replace(/\W+/g, "-")}`;
      await runEvent(
        h,
        {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "whatever" },
          error: kase.stderr,
          is_interrupt: false,
          duration_ms: 12,
        },
        session,
      );
      const [line] = await readOutcomes(h.home, session);

      expect(fromTs).toBe(kase.expected);
      expect(line?.c).toBe(kase.expected);
    });
  }
});
