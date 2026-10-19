// SPDX-License-Identifier: Apache-2.0
// Knowledge naming a file the checkout moved away from reaches the agent through the real hook script:
// on the session's first prompt through the digest (work done in the shell is seen by no edit hook), and
// once per session at an edit of the old file through the knowledge-gap channel. Writing the current
// file, or another one, pays zero bytes.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectPathDrift,
  pathDriftStubs,
  renderPathDriftDigest,
} from "@pathrule/core/knowledge-map/path-drift.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "ws-drift";
const RUNBOOK =
  "# On-call runbook\n\nOne row per error slug.\n\n| Slug | Status | Check first |\n| --- | --- | --- |\n";
const DRIFTS = detectPathDrift(
  [
    {
      id: "m1",
      title: "On-call runbook",
      content: "Every slug has a row in `docs/runbook.md`.",
      node_path: "/docs",
    },
  ],
  {
    files: ["docs/runbook.md", "docs/oncall/runbook.md", "README.md"],
    read: (p) =>
      ({
        "docs/runbook.md": RUNBOOK,
        "docs/oncall/runbook.md": RUNBOOK,
        "README.md": "docs/oncall/runbook.md",
      })[p] ?? null,
  },
);
const STUBS = pathDriftStubs(DRIFTS);
const DIGEST = renderPathDriftDigest(DRIFTS)!;

let home: string;
let hookScript: string;
let root: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-drift-"));
  hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  root = join(home, WS);
  await mkdir(join(root, "docs", "oncall"), { recursive: true });
  const cacheDir = join(home, "cache", WS);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS,
      workspace_root: root,
      generated_at: "2026-10-18T00:00:00.000Z",
      session_digest: DIGEST,
      path_memories: {},
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      knowledge_gaps: STUBS,
    }),
  );
  await writeFile(join(cacheDir, "warehouse.json"), "{}");
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function runPrompt(session: string, prompt: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PATHRULE_")),
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...env, PATHRULE_HOME: home }, timeout: 15_000 },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0)
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(
      JSON.stringify({
        session_id: session,
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt,
      }),
    );
  });
}

function runHook(session: string, tool: "Edit" | "Write", relPath: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PATHRULE_")),
  );
  const file_path = join(root, relPath);
  const tool_input =
    tool === "Edit"
      ? { file_path, old_string: "a", new_string: "| `gone` | 410 | x |" }
      : { file_path, content: "x" };
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...env, PATHRULE_HOME: home }, timeout: 15_000 },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0)
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(
      JSON.stringify({
        session_id: session,
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input,
      }),
    );
  });
}

const contextOf = (stdout: string): string => {
  try {
    return (
      (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? ""
    );
  } catch {
    return "";
  }
};

describe("path drift delivery in the hook", () => {
  it("tells the session's first prompt which files moved, once", async () => {
    const first = contextOf(
      await runPrompt("p-1", "Add a 405 for routes with methods, with tests."),
    );
    expect(first).toContain(DIGEST);
    expect(first).toContain(
      "- docs/runbook.md → docs/oncall/runbook.md (README.md names the new one)",
    );
    expect(contextOf(await runPrompt("p-1", "Now run the tests."))).not.toContain(
      "docs/oncall/runbook.md",
    );
  });

  it("tells the edit of the old file where the checkout points now, once per session", async () => {
    const first = contextOf(await runHook("s-1", "Edit", "docs/runbook.md"));
    expect(first).toContain(STUBS[0]!.line);
    expect(first).toContain("Write to docs/oncall/runbook.md");
    expect(contextOf(await runHook("s-1", "Edit", "docs/runbook.md"))).not.toContain(
      "docs/oncall/runbook.md",
    );
    expect(contextOf(await runHook("s-2", "Write", "docs/runbook.md"))).toContain(STUBS[0]!.line);
  });

  it("says nothing to an edit of the current file or of another one", async () => {
    expect(contextOf(await runHook("s-3", "Edit", "docs/oncall/runbook.md"))).not.toContain(
      "names docs/runbook.md",
    );
    expect(contextOf(await runHook("s-3", "Edit", "docs/errors.md"))).not.toContain(
      "names docs/runbook.md",
    );
  });
});
