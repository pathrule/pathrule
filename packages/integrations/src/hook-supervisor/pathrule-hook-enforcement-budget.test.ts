// SPDX-License-Identifier: Apache-2.0
// Enforcement must not be a function of the context display budget.
//
// The regression this guards, measured on rule 33 (`Never use cursor: pointer`): the
// deny check read its candidates from `matchRulesForPath`, which priority-sorts and
// truncates to the injection budget. Rule 33 is medium priority and landed at position
// 28 of 34 candidates against a limit of 12, so it was never regex-tested and an
// approved constraint silently stopped blocking. No path in that workspace could reach
// the check.
//
// Black-box: drives the real standalone hook script with real PreToolUse payloads
// against a seeded index, exactly as Claude Code invokes it.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WORKSPACE_ID = "ws-enforcement-budget";
const REMEDY = "Use a real <button> or <a>; they carry the pointer cursor and the semantics.";

let isolatedHome: string;
let hookScript: string;
let workspaceRoot: string;

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "pathrule-hook-enforcement-"));
  // CommonJS: must live outside packages/shared, which is "type":"module".
  hookScript = join(isolatedHome, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  workspaceRoot = join(isolatedHome, "repo");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  const cacheDir = join(isolatedHome, "cache", WORKSPACE_ID);
  await mkdir(cacheDir, { recursive: true });

  // 20 high-priority advisory rules ahead of one medium-priority strict rule, so the
  // strict one is well past both budgets in play (hook: 12, matcher default: 5).
  const noise = Array.from({ length: 20 }, (_, i) => ({
    id: `rule-noise-${i}`,
    name: `Noise rule ${i}`,
    preview: `Advisory noise ${i}.`,
    priority: "high",
    enforcement: "advisory",
  }));
  const index = {
    workspace_id: WORKSPACE_ID,
    workspace_root: workspaceRoot,
    generated_at: "2026-09-03T00:00:00.000Z",
    project_rules: [
      ...noise,
      {
        id: "rule-33",
        name: "Never use cursor: pointer",
        preview: "Never apply `cursor: pointer` to a div.",
        priority: "medium",
        enforcement: "strict",
        block_pattern: { source: "cursor:\\s*pointer", flags: "i", message: REMEDY },
      },
      // enforcement=strict with nothing compiled: the legacy column-only shape. Must
      // never enter the scan, or it would deny on a pattern that does not exist.
      {
        id: "rule-strict-bare",
        name: "Strict but unarmed",
        preview: "No compiled constraint.",
        priority: "high",
        enforcement: "strict",
      },
      // Path-only: the subject is WHERE the file is, so there is no content pattern and
      // reaching the path IS the violation.
      {
        id: "rule-mobile-md",
        name: "Never add markdown under packages/mobile/Pathrule/",
        preview: "Scope mobile companion files at the package root.",
        priority: "medium",
        enforcement: "strict",
        block_path: {
          scope_path: "/packages/mobile/Pathrule",
          file_extensions: [".md"],
          message: "Scope mobile knowledge at /packages/mobile, never under Pathrule/.",
        },
      },
      // Content pattern AND a path narrowing: an AND, so it must stay silent outside the
      // narrowed subtree even when the content matches.
      {
        id: "rule-scoped-content",
        name: "No TODO markers under packages/web",
        preview: "Track work in the board, not in the source.",
        priority: "medium",
        enforcement: "strict",
        block_pattern: { source: "FIXMEXYZ", flags: "", message: "Track it on the board instead." },
        block_path: { scope_path: "/packages/web", message: "Track it on the board instead." },
      },
    ],
    path_rules: {},
    fail_patterns: [],
  };
  await writeFile(join(cacheDir, "hook-index.json"), JSON.stringify(index), "utf8");

  // Edit/Write run the work-conflict guard BEFORE the block check; with no snapshot
  // the hook cold-paths to "degraded ask" and never reaches the deny.
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
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
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

function editPayload(sessionId: string, newString: string): unknown {
  return {
    session_id: sessionId,
    cwd: workspaceRoot,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: {
      file_path: join(workspaceRoot, "src", "Button.tsx"),
      old_string: "const a = 1;",
      new_string: newString,
    },
  };
}

function editPayloadAt(sessionId: string, filePath: string, newString: string): unknown {
  return {
    session_id: sessionId,
    cwd: workspaceRoot,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "const a = 1;", new_string: newString },
  };
}

describe("pathrule-hook.js enforcement is not budgeted", () => {
  it("denies an edit matching a strict rule the context budget would have dropped", async () => {
    const out = await runHook(editPayload("deny-1", ".cta { cursor: pointer; }"));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.decision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("Never use cursor: pointer");
  });

  it("carries the authored remedy into the deny reason", async () => {
    const out = await runHook(editPayload("deny-2", ".x { cursor:pointer }"));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    // A bare "blocked" leaves the agent with nothing to do differently.
    expect(out.reason).toContain(REMEDY);
    expect(out.reason).toContain("Do this instead");
  });

  it("matches case-insensitively and across whitespace, per the compiled flags", async () => {
    const out = await runHook(editPayload("deny-3", "div { CURSOR:   POINTER; }"));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("lets a clean edit through", async () => {
    const out = await runHook(editPayload("allow-1", ".cta { cursor: default; }"));
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out.decision).toBeUndefined();
  });

  it("does not deny a Write of unrelated content", async () => {
    const out = await runHook({
      session_id: "allow-2",
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(workspaceRoot, "src", "plain.ts"), content: "export const x = 1;" },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("leaves Read alone: enforcement is an Edit/Write concern", async () => {
    const out = await runHook({
      session_id: "read-1",
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: join(workspaceRoot, "src", "Button.tsx") },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("denies a path-only constraint with no content pattern", async () => {
    const out = await runHook({
      session_id: "path-deny-1",
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: join(workspaceRoot, "packages/mobile/Pathrule/CLAUDE.md"),
        content: "# Notes\n\nNothing forbidden in this text at all.",
      },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.reason).toContain("Scope mobile knowledge at /packages/mobile");
    // The reason names the real cause rather than claiming a pattern matched.
    expect(out.reason).toContain("forbids writing that file at that path");
  });

  it("leaves the package root alone, which is where the rule says the file belongs", async () => {
    const out = await runHook({
      session_id: "path-allow-1",
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(workspaceRoot, "packages/mobile/CLAUDE.md"), content: "# Notes" },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("leaves a non-markdown file under the narrowed subtree alone", async () => {
    const out = await runHook({
      session_id: "path-allow-2",
      cwd: workspaceRoot,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: join(workspaceRoot, "packages/mobile/Pathrule/Views/Foo.swift"),
        content: "struct Foo {}",
      },
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("treats a content pattern plus a path narrowing as an AND", async () => {
    const inside = await runHook(
      editPayloadAt("scoped-1", join(workspaceRoot, "packages/web/src/a.ts"), "const x = 'FIXMEXYZ';"),
    );
    expect(inside.hookSpecificOutput?.permissionDecision).toBe("deny");

    const outside = await runHook(
      editPayloadAt("scoped-2", join(workspaceRoot, "packages/core/src/a.ts"), "const x = 'FIXMEXYZ';"),
    );
    // Same forbidden content, outside the narrowed subtree: silent.
    expect(outside.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("still injects the advisory context channel, unchanged by the split", async () => {
    // Advisory injection is relevance-gated, so the edit text has to actually overlap a
    // rule for anything to be shown. That gate is not what this change touched.
    const out = await runHook(editPayload("context-1", "// Noise rule 0: advisory noise"));
    const context = out.hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("Pathrule context for");
    expect(context).toContain("Noise rule 0");
    // The display budget still excludes rule 33: it loses the priority race, exactly as
    // before. Enforcement no longer depends on that outcome.
    expect(context).not.toContain("Never use cursor: pointer");
  });
});
