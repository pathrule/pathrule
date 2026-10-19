// SPDX-License-Identifier: Apache-2.0
// Black-box fail-open smoke for the standalone hook script against
// every Copilot payload dialect. The script runs with an isolated
// PATHRULE_HOME (no hook-index, no workspace), so the expected outcome for
// every event is: exit 0 + parseable JSON + no injection — proving the
// copilot detection/normalization branch can never break a user's session
// even with nothing configured. Schema-level behavior is covered by the
// adapter + config-writer unit tests.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");

let isolatedHome: string;
let hookScript: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "pathrule-hook-smoke-"));
  // The script is CommonJS; in production it runs from ~/.pathrule/bin/
  // (outside any "type":"module" package). Mirror that layout here — running
  // it in-place would make Node treat it as ESM via packages/shared.
  hookScript = join(isolatedHome, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
});

afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

function runHook(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: isolatedHome,
          ...extraEnv,
        },
        timeout: 10_000,
      },
      (error, stdout) => {
        // execFile errors on non-zero exit; the hook must always exit 0.
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        if (error && error.killed) {
          reject(new Error("hook timed out"));
          return;
        }
        resolve({ stdout, code: 0 });
      },
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

describe("pathrule-hook.js × Copilot dialects (fail-open)", () => {
  it("CLI camelCase sessionStart with env stamp → exit 0, parseable JSON", async () => {
    const { stdout } = await runHook(
      {
        sessionId: "copilot-smoke-1",
        timestamp: 1765000000000,
        cwd: isolatedHome,
        source: "startup",
      },
      { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: "sessionStart" },
    );
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it("CLI camelCase preToolUse (toolName/toolArgs) → exit 0, no deny without rules", async () => {
    const { stdout } = await runHook(
      {
        sessionId: "copilot-smoke-2",
        timestamp: 1765000000000,
        cwd: isolatedHome,
        toolName: "edit",
        toolArgs: { filePath: join(isolatedHome, "src/app.ts") },
      },
      { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: "preToolUse" },
    );
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.decision).toBeUndefined();
  });

  it("VS Code dialect postToolUse (hookEventName) → exit 0, parseable JSON", async () => {
    const { stdout } = await runHook({
      hookEventName: "PostToolUse",
      sessionId: "copilot-smoke-3",
      timestamp: "2026-06-07T00:00:00.000Z",
      cwd: isolatedHome,
      tool_name: "editFiles",
      tool_input: { filePath: join(isolatedHome, "src/app.ts") },
      tool_response: "ok",
    });
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it("Copilot sessionStart source:'startup' is NOT misdetected as codex (env-stamp wins)", async () => {
    // A codex misdetection would not crash either, but the dedicated copilot
    // branch must own the payload: malformed copilot-only fields prove it.
    const { stdout } = await runHook(
      {
        sessionId: "copilot-smoke-4",
        source: "startup",
        cwd: isolatedHome,
        initialPrompt: "hello",
      },
      { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: "sessionStart" },
    );
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });

  it("garbage copilot payload → exit 0, empty object", async () => {
    const { stdout } = await runHook(
      { toolName: 42, toolArgs: "not-an-object" },
      { PATHRULE_HOOK_CLIENT: "copilot" },
    );
    expect(JSON.parse(stdout.trim())).toEqual({});
  });
});

// ─── Strict-rule DENY enforcement across both Copilot dialects ──────────────
// This is the highest-risk path: a blocked edit must actually be denied on
// every Copilot surface, in the dialect-correct output shape. We seed a real
// hook-index with a strict block_pattern rule and drive the live hook script
// with synthetic Copilot PreToolUse payloads — no Copilot subscription needed.
// Proves: (a) env-stamp client detection, (b) tool_name normalization
// (editFiles/edit → Edit), (c) per-dialect denormalization of the deny.
describe("pathrule-hook.js × Copilot strict-rule DENY", () => {
  const WORKSPACE_ID = "ws-copilot-deny";
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = join(isolatedHome, "repo");
    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    const cacheDir = join(isolatedHome, "cache", WORKSPACE_ID);
    await mkdir(cacheDir, { recursive: true });
    const index = {
      workspace_id: WORKSPACE_ID,
      workspace_root: workspaceRoot,
      generated_at: "2026-06-07T00:00:00.000Z",
      project_rules: [
        {
          id: "rule-no-eval",
          name: "No eval() in app code",
          preview: "eval() is forbidden.",
          priority: "high",
          enforcement: "strict",
          block_pattern: { source: "eval\\(", flags: "" },
        },
      ],
      path_rules: {},
      fail_patterns: [],
    };
    await writeFile(join(cacheDir, "hook-index.json"), JSON.stringify(index), "utf8");

    // Edit/Write tools run the work-conflict guard BEFORE the block_pattern
    // check; with no snapshot the hook cold-paths to "degraded ask" and never
    // reaches the strict deny. In production the desktop app maintains this
    // snapshot — seed a fresh, conflict-free one so the deny path is exercised.
    const snapshot = {
      schema_version: 1,
      workspace_id: WORKSPACE_ID,
      generated_at: new Date().toISOString(),
      rows_by_path: {},
      display_names_by_user_id: {},
    };
    await writeFile(
      join(cacheDir, "work-state-snapshot.json"),
      JSON.stringify(snapshot),
      "utf8",
    );
  });

  const targetFile = () => join(workspaceRoot, "src", "app.ts");

  it("Copilot CLI dialect: edit matching block_pattern → top-level permissionDecision deny", async () => {
    const { stdout } = await runHook(
      {
        sessionId: "deny-cli-1",
        cwd: workspaceRoot,
        toolName: "edit",
        toolArgs: { filePath: targetFile(), content: "const x = eval('1+1');" },
      },
      { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: "preToolUse" },
    );
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.permissionDecision).toBe("deny");
    expect(typeof out.permissionDecisionReason).toBe("string");
    // CLI dialect uses top-level fields, NOT the VS Code envelope.
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("Copilot VS Code dialect: editFiles matching block_pattern → hookSpecificOutput deny", async () => {
    const { stdout } = await runHook({
      hookEventName: "PreToolUse",
      sessionId: "deny-vscode-1",
      cwd: workspaceRoot,
      tool_name: "editFiles",
      tool_input: { filePath: targetFile(), content: "const x = eval('1+1');" },
    });
    const out = JSON.parse(stdout.trim()) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      permissionDecision?: string;
    };
    // VS Code dialect wraps the decision in the hookSpecificOutput envelope.
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(typeof out.hookSpecificOutput?.permissionDecisionReason).toBe("string");
    expect(out.permissionDecision).toBeUndefined();
  });

  it("Copilot CLI dialect: edit NOT matching block_pattern → no deny", async () => {
    const { stdout } = await runHook(
      {
        sessionId: "deny-cli-2",
        cwd: workspaceRoot,
        toolName: "edit",
        toolArgs: { filePath: targetFile(), content: "const x = 1 + 1;" },
      },
      { PATHRULE_HOOK_CLIENT: "copilot", PATHRULE_HOOK_EVENT: "preToolUse" },
    );
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});
