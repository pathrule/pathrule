// SPDX-License-Identifier: Apache-2.0
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
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
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
  await rm(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

function bash(command: string, ok: boolean): unknown {
  return {
    session_id: SESSION,
    cwd: workspaceRoot,
    hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command },
    ...(ok ? { tool_response: { is_error: false, stdout: "ok" } } : { error: "1 test failed" }),
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
  it("1. a clean Stop before any edit is not blocked", async () => {
    const out = await runHook(stop());
    expect(out.decision).toBeUndefined();
    expect(await pendingCount()).toBe(0);
  });

  it("2. an edit outside the scope does not make anything pending", async () => {
    await runHook(edit("packages/core/src/x.ts"));
    expect(await pendingCount()).toBe(0);
    const out = await runHook(stop());
    expect(out.decision).toBeUndefined();
  });

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

  it("5. the recursion guard stops the block from re-firing on its own continuation", async () => {
    const out = await runHook(stop(true));
    expect(out.decision).toBeUndefined();
    // Still owed: the guard suppresses the block, it does not satisfy the check.
    expect(await pendingCount()).toBe(1);
  });

  it("6. a FAILING run of the required command does not clear it", async () => {
    await runHook(bash(COMMAND, false));
    expect(await pendingCount()).toBe(1);
    expect((await runHook(stop())).decision).toBe("block");
  });

  it("7. a PASSING run of a DIFFERENT package does not clear it", async () => {
    await runHook(bash("pnpm --filter @pathrule/core test", true));
    expect(await pendingCount()).toBe(1);
    expect((await runHook(stop())).decision).toBe("block");
  });

  it("8. a PASSING run whose exit code was piped away does not clear it", async () => {
    // The evidence channel refuses to fingerprint a piped command, so there is nothing
    // to match. This is the false-PASS this design exists to prevent.
    await runHook(bash(`${COMMAND} | tail -5`, true));
    expect(await pendingCount()).toBe(1);
    expect((await runHook(stop())).decision).toBe("block");
  });

  it("9. a PASSING run of the required command clears it", async () => {
    await runHook(bash(COMMAND, true));
    expect(await pendingCount()).toBe(0);
  });

  it("10. Stop is allowed once the verification passed", async () => {
    const out = await runHook(stop());
    expect(out.decision).toBeUndefined();
  });

  it("11. a new edit after the pass makes it pending again", async () => {
    // A suite that passed before this edit says nothing about the code after it.
    await runHook(edit("packages/shared/src/y.ts"));
    expect(await pendingCount()).toBe(1);
  });

  it("12. Stop blocks again", async () => {
    expect((await runHook(stop())).decision).toBe("block");
  });

  it("13. the open hook keeps no injection log; the cloud extension records the block", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(isolatedHome, "cache", WORKSPACE_ID, "injections.jsonl"))).toBe(false);
  });
});

describe("CHECK does not disturb what was already there", () => {
  it("a Write outside any check scope still reaches Stop cleanly", async () => {
    const session = "check-gate-untouched";
    await runHook({
      session_id: session,
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(workspaceRoot, "packages/core/src/z.ts"), content: "export const z = 1;" },
    });
    const out = await runHook({ session_id: session, cwd: workspaceRoot, hook_event_name: "Stop" });
    expect(out.decision).toBeUndefined();
  });

  it("a rule with no required_check never makes anything pending", async () => {
    const session = "check-gate-no-check";
    await runHook({
      session_id: session,
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: join(workspaceRoot, "packages/core/src/q.ts"),
        old_string: "a",
        new_string: "b",
      },
    });
    const file = join(isolatedHome, "cache", WORKSPACE_ID, `session-${session}.json`);
    const raw = await readFile(file, "utf8").catch(() => "");
    const state = raw ? (JSON.parse(raw) as { pending_checks?: unknown[] }) : {};
    expect(state.pending_checks ?? []).toEqual([]);
  });
});

describe('approved opaque command gate',()=>{
 it('requires the exact observed argv and a confirmed pass after an in-scope edit',async()=>{
  const session='opaque-check-gate',command='northstar-check audit --strict';
  const fingerprint='opaque.v1:'+createHash('sha256').update(JSON.stringify(command.split(' '))).digest('hex');
  await writeFile(join(isolatedHome,'cache',WORKSPACE_ID,'hook-index.json'),JSON.stringify({
   workspace_id:WORKSPACE_ID,workspace_root:workspaceRoot,generated_at:'2026-09-03T00:00:00.000Z',
   project_rules:[{id:RULE_ID,name:'Approved audit',preview:'Run the project audit.',priority:'high',enforcement:'advisory',
    required_check:{scope_path:'/packages/shared',command,fingerprint,message:'Run the project audit before completion.'}}],
   path_rules:{},fail_patterns:[],
  }),'utf8');
  const asSession=(payload:unknown)=>({...payload as Record<string,unknown>,session_id:session});
  await runHook(asSession(edit('packages/shared/src/opaque.ts')));
  expect((await runHook(asSession(stop()))).decision).toBe('block');
  for(const other of ['northstar-check audit --relaxed',`${command} | tail -1`]){
   await runHook(asSession(bash(other,true)));
   expect((await runHook(asSession(stop()))).decision).toBe('block');
  }
  await runHook(asSession(bash(command,false)));
  expect((await runHook(asSession(stop()))).decision).toBe('block');
  await runHook(asSession(bash(command,true)));
  expect((await runHook(asSession(stop()))).decision).toBeUndefined();
 });
});
