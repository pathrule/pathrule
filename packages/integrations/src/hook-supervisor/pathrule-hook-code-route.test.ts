// SPDX-License-Identifier: Apache-2.0
// The code map routes a prompt to the definition its words name, as file:line, so the agent opens the
// right place instead of searching. Measured on the public benchmark: with knowledge alone, the agent
// made as many Read/Grep/Glob calls as with no memory at all.
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "77777777-7777-7777-7777-777777777777";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true }))); });

async function routeFor(prompt: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-code-route-"));
  homes.push(home);
  const hook = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hook), { recursive: true });
  await copyFile(HOOK, hook);
  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cache = join(home, "cache", WS);
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "hook-index.json"), JSON.stringify({
    workspace_id: WS, workspace_root: wsRoot, generated_at: "2026-10-15T00:00:00.000Z", session_digest: "",
    path_memories: {}, path_rules: {}, project_rules: [], recent_subjects: [],
    code_map: {
      symbols: [
        ["elapsedTime", "/lib/reply.js:88", ["elapsedtime", "elapsed", "time"]],
        ["onSendHook", "/lib/reply.js:565", ["onsendhook", "send", "hook"]],
        ["timeout", "/lib/server.js:12", ["timeout"]],
      ],
      idf: { elapsedtime: 6.5, elapsed: 6.5, time: 5.6, onsendhook: 6.5, send: 4, hook: 3, timeout: 5 },
      forms: { elapseds: "elapsed", times: "time", sends: "send", sent: "send", hooks: "hook", timeouts: "timeout" },
    },
  }));
  await writeFile(join(cache, "warehouse.json"), "{}");
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hook], { env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit", PATHRULE_NAVIGATION: "on" }, timeout: 10_000 }, (error, stdout) => {
      if (error && typeof error.code === "number" && error.code !== 0) return reject(new Error(stdout));
      try { resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? ""); } catch { resolve(stdout); }
    });
    child.stdin!.end(JSON.stringify({ cwd: wsRoot, session_id: "r1", hook_event_name: "UserPromptSubmit", prompt }));
  });
}

describe("code route", () => {
  it("routes to the definition a prompt's words name", async () => {
    const out = await routeFor("Where is a reply's elapsed time computed?");
    expect(out).toMatch(/^- \/lib\/reply\.js:88 \(defines elapsedTime\)/m);
  });

  it("routes on an exact identifier in the prompt", async () => {
    expect(await routeFor("Explain what onSendHook does before a response leaves.")).toMatch(/\/lib\/reply\.js:565 \(defines onSendHook\)/);
  });

  it("counts the forms of one word once", async () => {
    expect(await routeFor("How do the hooks hook in, which hooks run first?")).not.toMatch(/defines /);
  });

  it("stays silent when only one common word matches", async () => {
    expect(await routeFor("How much time does the full test suite take to run?")).not.toMatch(/defines /);
  });
});
