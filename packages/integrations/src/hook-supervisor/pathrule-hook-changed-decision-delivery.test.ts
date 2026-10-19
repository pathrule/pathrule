// SPDX-License-Identifier: Apache-2.0
// A changed decision reaches the agent WRITING the superseded value, once per session, through the
// real hook script. An edit that never writes the old value pays zero bytes.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedDecisionStubs, selectChangedDecision } from "@pathrule/core/knowledge-map/changed-decisions.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WITH = "ws-cd-on";
const WITHOUT = "ws-cd-off";
const STUBS = changedDecisionStubs([
  {
    id: "m1",
    title: "New error types use errors.acme.io",
    content: "Error types created from now on use `https://errors.acme.io/` instead of `https://errors.acme.dev/`; existing ones keep their URLs for now.",
    node_path: "/acme",
  },
]);

let home: string;
let hookScript: string;
const roots: Record<string, string> = {};

async function workspace(id: string, extra: Record<string, unknown>): Promise<void> {
  const root = join(home, id);
  roots[id] = root;
  await mkdir(join(root, "acme"), { recursive: true });
  await mkdir(join(root, "cli"), { recursive: true });
  const cacheDir = join(home, "cache", id);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({ workspace_id: id, workspace_root: root, generated_at: "2026-10-16T00:00:00.000Z", session_digest: "", path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [], ...extra }),
  );
  await writeFile(join(cacheDir, "warehouse.json"), "{}");
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-cd-"));
  hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await workspace(WITH, { changed_decisions: STUBS });
  await workspace(WITHOUT, {});
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function runHook(id: string, session: string, tool: "Edit" | "Write" | "Read", relPath: string, text: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PATHRULE_")));
  const file_path = join(roots[id]!, relPath);
  const tool_input = tool === "Edit" ? { file_path, old_string: "a", new_string: text } : tool === "Write" ? { file_path, content: text } : { file_path };
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hookScript], { env: { ...env, PATHRULE_HOME: home }, timeout: 15_000 }, (error, stdout) => {
      if (error && typeof error.code === "number" && error.code !== 0) reject(new Error(`hook exited ${error.code}: ${stdout}`));
      else resolve(stdout.trim());
    });
    child.stdin?.end(JSON.stringify({ session_id: session, cwd: roots[id], hook_event_name: "PreToolUse", tool_name: tool, tool_input }));
  });
}

const contextOf = (stdout: string): string => {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
};

const OLD = 'return problem(410, "Gone", detail, "gone", base="https://errors.acme.dev/")';

describe("changed decision delivery in the hook", () => {
  it("tells the edit that writes the superseded value, once per session, and the write too", async () => {
    const first = contextOf(await runHook(WITH, "s1", "Edit", "acme/app.py", OLD));
    expect(first).toContain(STUBS[0]!.line);
    const second = contextOf(await runHook(WITH, "s1", "Edit", "acme/http.py", OLD));
    expect(second).not.toContain("later decision");
    const written = contextOf(await runHook(WITH, "s2", "Write", "acme/new.py", `# new\n${OLD}\n`));
    expect(written).toContain(STUBS[0]!.line);
  });

  it("never tells a read, an edit outside the scope, or an edit that writes the new value", async () => {
    expect(contextOf(await runHook(WITH, "s3", "Read", "acme/app.py", OLD))).not.toContain("later decision");
    expect(contextOf(await runHook(WITH, "s4", "Edit", "cli/main.py", OLD))).not.toContain("later decision");
    expect(contextOf(await runHook(WITH, "s5", "Edit", "acme/app.py", OLD.replace("acme.dev", "acme.io")))).not.toContain("later decision");
  });

  it("costs nothing otherwise: output is byte-identical to an index without changed decisions", async () => {
    const on = await runHook(WITH, "s6", "Edit", "acme/app.py", "x = 1");
    const off = await runHook(WITHOUT, "s6", "Edit", "acme/app.py", "x = 1");
    expect(on).toBe(off);
  });

  it("selects exactly what the TypeScript twin selects", () => {
    const index = { changed_decisions: STUBS };
    expect(selectChangedDecision(index, "/acme/app.py", OLD, new Set())).toEqual(STUBS[0]);
    expect(selectChangedDecision(index, "cli/main.py", OLD, new Set())).toBeNull();
    expect(selectChangedDecision(index, "acme/app.py", OLD, new Set([STUBS[0]!.ref]))).toBeNull();
  });
});
