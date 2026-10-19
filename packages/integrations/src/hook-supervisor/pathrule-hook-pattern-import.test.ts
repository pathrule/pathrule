// SPDX-License-Identifier: Apache-2.0
// Black-box guarantee that the standalone offline hook treats
// `::pathrule:package:<slug>` as a PATTERN IMPORT, never a skill. This is the
// offline mirror of the MCP get_context behaviour: the same prompt typed in a
// cloud session vs an offline session must distinguish skill from pattern
// identically. Regression guard for the production bug where the token was
// mis-parsed as the skill `pathrule` and fired the find-skills protocol.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "11111111-1111-1111-1111-111111111111";

let home: string;
let hookScript: string;
let wsRoot: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-pattern-"));
  hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-06-09T00:00:00.000Z",
      session_digest: "",
      skill_invocation_index: {
        "code-review": [
          { id: "skill-1", name: "code-review", preview: "Review the diff.", body: "INVOKED_SKILL_BODY" },
        ],
      },
      path_memories: {},
      project_rules: [],
      recent_subjects: [],
    }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function runPrompt(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
        },
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed?.hookSpecificOutput?.additionalContext ?? "");
        } catch {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: wsRoot, prompt, hook_event_name: "UserPromptSubmit" }));
  });
}

const MISSING_SKILL_MARKER = "did not find exact workspace skill";

describe("offline hook × ::pathrule:package:<slug> (pattern import, not a skill)", () => {
  it("emits the pattern-import directive and NEVER the find-skills block", async () => {
    const ctx = await runPrompt("add ::pathrule:package:expo-react-native to this workspace");
    expect(ctx).toContain("pathrule_import_pattern");
    expect(ctx).toContain("Pathrule pattern import");
    // The exact production bug: the token must NOT be read as the skill `pathrule`.
    expect(ctx).not.toContain(MISSING_SKILL_MARKER);
    expect(ctx).not.toContain("Pathrule invoked skills");
  });

  it("still fires find-skills for a genuinely missing ::skill", async () => {
    const ctx = await runPrompt("please ::totally-unknown-skill help");
    expect(ctx).toContain(MISSING_SKILL_MARKER);
    expect(ctx).not.toContain("pathrule_import_pattern");
  });

  it("still resolves a real workspace ::skill invocation", async () => {
    const ctx = await runPrompt("run ::code-review on my diff");
    expect(ctx).toContain("Pathrule invoked skills");
    // An explicit ::skill is a hard gate: the body rides the context itself, so the
    // agent follows it without depending on a tool call it may skip.
    expect(ctx).toContain("INVOKED_SKILL_BODY");
    expect(ctx).not.toContain(MISSING_SKILL_MARKER);
    expect(ctx).not.toContain("pathrule_import_pattern");
  });
});
