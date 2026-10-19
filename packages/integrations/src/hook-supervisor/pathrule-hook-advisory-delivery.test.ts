// SPDX-License-Identifier: Apache-2.0
// Black-box guarantee that the offline UserPromptSubmit hook now delivers the compiled Agent IR
// ADVISORIES (REMEDY / SELECTION / PROCEDURE / CONTEXT / RATIONALE) up front on the prompt, not only
// later on a PreToolUse. The index carries pre-rendered advisory lines under path_advisories /
// project_advisories (assembleHookIndex); this proves the hook selects them for the cwd, renders them
// under the subordinate advisory header, and delta-gates by ref (one delivery per session).

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "33333333-3333-3333-3333-333333333333";
const ADVISORY_HEADER = "💡 Pathrule advisories";
const REMEDY_LINE = "- REMEDY: when the API body is empty, return null before JSON.parse (incident 217).";
const SELECTION_LINE = "- SELECTION: for server-side API calls, prefer ServerClient over GenericClient.";
const PROJECT_LINE = "- CONTEXT: this service runs read-only against the analytics replica.";
const PROMPT = "Add a parseResponse helper that reads and parses the upstream API body.";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome(): Promise<{ home: string; hookScript: string; wsRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-advisory-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-06-11T00:00:00.000Z",
      session_digest: "",
      path_memories: {},
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      // Pre-rendered advisory lines, exactly as assembleHookIndex emits them: {ref, line}, grouped by
      // scope. Two path-scoped (cwd "/") + one project-wide.
      path_advisories: {
        "/": [
          { ref: "adv-remedy-1", line: REMEDY_LINE },
          { ref: "adv-selection-1", line: SELECTION_LINE },
        ],
      },
      project_advisories: [{ ref: "adv-context-1", line: PROJECT_LINE }],
    }),
  );
  await writeFile(join(cacheDir, "warehouse.json"), JSON.stringify({}));
  return { home, hookScript, wsRoot };
}

function runPrompt(home: string, hookScript: string, wsRoot: string, prompt: string, sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit", PATHRULE_NAVIGATION: "on" }, timeout: 10_000 },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) { reject(new Error(`hook exited ${error.code}: ${stdout}`)); return; }
        try { resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? ""); } catch { resolve(stdout.trim()); }
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: wsRoot, prompt, session_id: sessionId, hook_event_name: "UserPromptSubmit" }));
  });
}

describe("offline hook × Agent IR advisory delivery on UserPromptSubmit", () => {
  it("delivers path + project advisories under the subordinate advisory header on the first prompt", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "adv-a");
    expect(ctx).toContain(ADVISORY_HEADER);
    expect(ctx).toContain(REMEDY_LINE);
    expect(ctx).toContain(SELECTION_LINE);
    expect(ctx).toContain(PROJECT_LINE); // project_advisories apply everywhere
  });

  it("keeps advisories subordinate: the header states they never override a rule/constraint/policy", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "adv-sub");
    expect(ctx).toMatch(/advisory only.*never override a rule/i);
  });

  it("delta-gates by ref: the same session does NOT re-deliver an already-delivered advisory", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const first = await runPrompt(home, hookScript, wsRoot, PROMPT, "adv-b");
    expect(first).toContain(REMEDY_LINE);
    const second = await runPrompt(home, hookScript, wsRoot, "Now add a second helper for the response body.", "adv-b");
    expect(second).not.toContain(REMEDY_LINE);
    expect(second).not.toContain(SELECTION_LINE);
  });

  it("a fresh session delivers the advisories again (delta is per-session, not global)", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    await runPrompt(home, hookScript, wsRoot, PROMPT, "adv-c1");
    const fresh = await runPrompt(home, hookScript, wsRoot, PROMPT, "adv-c2");
    expect(fresh).toContain(REMEDY_LINE);
  });
});
