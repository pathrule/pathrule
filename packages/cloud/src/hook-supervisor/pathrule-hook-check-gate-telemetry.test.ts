// SPDX-License-Identifier: Apache-2.0
// The cloud half of pathrule-hook-check-gate.test.ts (@pathrule/integrations): a CHECK block as the
// cloud extension records it in the injection log.
// The CHECK chain, driven end to end through the real hook script:
//
//   Edit inside scope        -> pending
//   Stop                     -> decision: "block" + authored message + required command
//   PASS evidence            -> pending cleared
//   Stop                     -> allowed
//   Edit again               -> pending again
//   Stop                     -> blocked again
//
// The ordering is the point, so these run as one sequential story on one session rather
// than as independent cases.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The open hook, with the extensions this behaviour needs beside it, the way the official build installs them.
const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const CLOUD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook-cloud.cjs");
const WORKSPACE_ID = "ws-check-gate";
const RULE_ID = "4a4fe2f2-4d31-402e-a1e4-e2e08676fd27";
const COMMAND = "pnpm --filter @pathrule/shared test";
const FINGERPRINT = "pnpm:test@package:@pathrule/shared";
const MESSAGE = "Behaviour changed under packages/shared, so its suite has to pass before this is done.";

let isolatedHome: string;
let hookScript: string;
let workspaceRoot: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "pathrule-hook-check-"));
  hookScript = join(isolatedHome, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await copyFile(CLOUD_EXTENSION, join(dirname(hookScript), "pathrule-hook-cloud.cjs"));

  workspaceRoot = join(isolatedHome, "repo");
  await mkdir(join(workspaceRoot, "packages", "shared", "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "packages", "core", "src"), { recursive: true });
  const cacheDir = join(isolatedHome, "cache", WORKSPACE_ID);
  await mkdir(cacheDir, { recursive: true });

  // Medium priority behind high-priority noise, so the check also proves enforcement is
  // not subject to the context display budget.
  const noise = Array.from({ length: 20 }, (_, i) => ({
    id: `rule-noise-${i}`,
    name: `Noise rule ${i}`,
    preview: `Advisory noise ${i}.`,
    priority: "high",
    enforcement: "advisory",
  }));
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WORKSPACE_ID,
      workspace_root: workspaceRoot,
      generated_at: "2026-09-03T00:00:00.000Z",
      project_rules: [
        ...noise,
        {
          id: RULE_ID,
          name: "Write and run tests with every change",
          preview: "Behaviour changes ship with tests in the same effort.",
          priority: "medium",
          enforcement: "advisory",
          required_check: {
            scope_path: "/packages/shared",
            command: COMMAND,
            fingerprint: FINGERPRINT,
            message: MESSAGE,
          },
        },
      ],
      path_rules: {},
      fail_patterns: [],
    }),
    "utf8",
  );
  await writeFile(
    join(cacheDir, "work-state-snapshot.json"),
    JSON.stringify({
      schema_version: 1,
      workspace_id: WORKSPACE_ID,
      generated_at: new Date().toISOString(),
      rows_by_path: {},
      display_names_by_user_id: {},
    }),
    "utf8",
  );
});

afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

interface HookOutput {
  decision?: string;
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
}

function runHook(payload: unknown): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...process.env, PATHRULE_HOME: isolatedHome }, timeout: 15_000 },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        if (error?.killed) {
          reject(new Error("hook timed out"));
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed ? (JSON.parse(trimmed) as HookOutput) : {});
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

const SESSION = "check-gate-story";

function edit(relPath: string): unknown {
  return {
    session_id: SESSION,
    cwd: workspaceRoot,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: join(workspaceRoot, relPath),
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    },
  };
}

function stop(recursive = false): unknown {
  return {
    session_id: SESSION,
    cwd: workspaceRoot,
    hook_event_name: "Stop",
    ...(recursive ? { stop_hook_active: true } : {}),
  };
}

async function pendingCount(): Promise<number> {
  const file = join(isolatedHome, "cache", WORKSPACE_ID, `session-${SESSION}.json`);
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw) return 0;
  const state = JSON.parse(raw) as { pending_checks?: unknown[] };
  return Array.isArray(state.pending_checks) ? state.pending_checks.length : 0;
}

describe("CHECK gate, in order", () => {

  it("3. an edit inside the scope makes the check pending", async () => {
    await runHook(edit("packages/shared/src/x.ts"));
    expect(await pendingCount()).toBe(1);
  });

  it("4. Stop blocks, and says both why and exactly what to run", async () => {
    const out = await runHook(stop());
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Write and run tests with every change");
    expect(out.reason).toContain(MESSAGE);
    expect(out.reason).toContain(COMMAND);
  });

  it("13. the block is recorded in telemetry with the right rule id", async () => {
    const file = join(isolatedHome, "cache", WORKSPACE_ID, "injections.jsonl");
    const rows = (await readFile(file, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { decision?: string; rule_ids?: string[] })
      .filter((r) => r.decision === "check_block");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.rule_ids).toEqual([RULE_ID]);
  });
});

