// SPDX-License-Identifier: Apache-2.0
// Continuity across context resets, through the real hook process:
//  - every prompt of a session with the MCP server carries the capture reminder, and none without it;
//  - a compaction lets atoms already delivered reach the next edit again (the summary dropped them),
//    while a resume, which keeps the transcript, does not repeat them.
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "55555555-5555-5555-5555-555555555555";
const REMINDER = "Pathrule: CAPTURE_REMINDER_MARKER";
const LINE = "- the preferred choice is `enqueueMessage()` over `smsGateway.send`. [preference]";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-continuity-"));
  homes.push(home);
  const hook = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hook), { recursive: true });
  await copyFile(HOOK, hook);
  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "src", "notifications"), { recursive: true });
  const cache = join(home, "cache", WS);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "hook-index.json"), JSON.stringify({
    workspace_id: WS, workspace_root: wsRoot, generated_at: "2026-10-15T00:00:00.000Z", session_digest: "",
    path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [],
    path_advisories: { "/src/notifications": [{ ref: "adv-queue", line: LINE }] },
    capture_reminder: REMINDER,
  }));
  await writeFile(join(cache, "warehouse.json"), "{}");
  return { home, hook, wsRoot };
}

function run(h: { home: string; hook: string; wsRoot: string }, event: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [h.hook], { env: { ...process.env, PATHRULE_HOME: h.home, PATHRULE_HOOK_EVENT: event, ...env }, timeout: 10_000 }, (error, stdout) => {
      if (error && typeof error.code === "number" && error.code !== 0) return reject(new Error(`hook exited ${error.code}: ${stdout}`));
      try { resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? ""); } catch { resolve(stdout.trim()); }
    });
    child.stdin!.end(JSON.stringify({ cwd: h.wsRoot, hook_event_name: event, ...payload }));
  });
}
const edit = (h: { wsRoot: string }, session: string) => ({ session_id: session, tool_name: "Edit", tool_input: { file_path: join(h.wsRoot, "src/notifications/refund.js"), old_string: "a", new_string: "b" } });

describe("hook continuity", () => {
  it("shows the capture reminder with every prompt when the MCP server is there, never without it", async () => {
    const h = await makeHome();
    expect(await run(h, "UserPromptSubmit", { session_id: "c1", prompt: "Receipts show refunds as İade." })).toContain(REMINDER);
    expect(await run(h, "UserPromptSubmit", { session_id: "c1", prompt: "Now add the CSV export." })).toContain(REMINDER);
    expect(await run(h, "UserPromptSubmit", { session_id: "c2", prompt: "x" }, { PATHRULE_HOOK_MCP: "none" })).not.toContain(REMINDER);
  });

  it("re-delivers an atom after a compaction, and not after the session ends and is resumed", async () => {
    const h = await makeHome();
    await run(h, "SessionStart", { session_id: "s1", source: "startup" });
    expect(await run(h, "PreToolUse", edit(h, "s1"))).toContain("enqueueMessage");
    expect(await run(h, "PreToolUse", edit(h, "s1"))).not.toContain("enqueueMessage");
    await run(h, "SessionEnd", { session_id: "s1", reason: "prompt_input_exit" });
    await run(h, "SessionStart", { session_id: "s1", source: "resume" });
    expect(await run(h, "PreToolUse", edit(h, "s1"))).not.toContain("enqueueMessage");
    await run(h, "SessionStart", { session_id: "s1", source: "compact" });
    expect(await run(h, "PreToolUse", edit(h, "s1"))).toContain("enqueueMessage");
  });
});
