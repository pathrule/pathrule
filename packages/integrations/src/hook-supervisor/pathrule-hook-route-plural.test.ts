// SPDX-License-Identifier: Apache-2.0
// A prompt about "the daily report" routes to /src/reports. The route compared prompt words with folder
// words exactly, so the singular never met the plural folder and the route stayed silent.
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "77777777-7777-7777-7777-777777777777";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

async function routeFor(prompt: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-route-plural-"));
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
    path_memories: { "/src/reports": [{ id: "m1", title: "Clock", preview: "read the clock", node_path: "/src/reports", content_hash: "h" }] },
    path_rules: {}, project_rules: [], recent_subjects: [],
    hot_paths: [{ path: "/src/reports", count: 3 }],
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

describe("route words", () => {
  it("meet a plural folder from a singular prompt word", async () => {
    expect(await routeFor("Change the daily report header.")).toMatch(/^- \/src\/reports\b/m);
  });
});
