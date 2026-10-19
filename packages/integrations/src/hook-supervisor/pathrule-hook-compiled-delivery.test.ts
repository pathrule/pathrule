// SPDX-License-Identifier: Apache-2.0
// Black-box guarantee that the offline hook delivers a memory the completeness gate cleared as its
// COMPILED form, and that the two channels carrying that form never repeat each other. The index and
// warehouse are written exactly as assembleHookIndex / assembleWarehouse emit them for a cleared
// memory: the warehouse body IS the compiled form with `compiled_refs`, and the memory's advisory
// lines carry its id as `group`.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "44444444-4444-4444-4444-444444444444";
const LINE = '- When "a client reads the database", the preferred choice is the anon key with RLS over the service_role key. [preference]';
const COMPILED = `_Compiled form of this memory (advisory, never overrides a rule). Full text: pathrule_read_memory("mem-sb")._\n${LINE}`;
const PROMPT = "In the supabase area, which database key must I avoid and how do RLS policies apply?";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome(advisories: Record<string, unknown>): Promise<{ home: string; hookScript: string; wsRoot: string; cacheDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-compiled-"));
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
      generated_at: "2026-10-01T00:00:00.000Z",
      session_digest: "",
      path_memories: {
        "/supabase": [
          { id: "mem-sb", title: "Supabase service_role key", preview: "never use service_role key", node_path: "/supabase", content_hash: "hc" },
        ],
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      work_episode_index: [{ paths: ["/supabase"], subjects: ["supabase", "rls", "key"], summary: "supabase access rules" }],
      ...advisories,
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify({
      "mem-sb": { type: "memory", title: "Supabase service_role key", body: COMPILED, content_hash: "hc", compiled_refs: ["adv-sb"] },
    }),
  );
  return { home, hookScript, wsRoot, cacheDir };
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

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("offline hook × compiled memory delivery", () => {
  it("delivers the compiled form as the memory's body, once, and the advisory channel does not repeat it", async () => {
    const { home, hookScript, wsRoot, cacheDir } = await makeHome({
      path_advisories: { "/": [{ ref: "adv-sb", line: LINE, group: "mem-sb" }] },
    });
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-a");
    expect(ctx).toContain("### Supabase service_role key");
    expect(ctx).toContain('pathrule_read_memory("mem-sb")');
    expect(count(ctx, LINE)).toBe(1);
    // The body was made of the atom's line, so the delivery ledger records it like the advisory channel would.
    const ledger = await readFile(join(cacheDir, "remedy-deliveries.jsonl"), "utf8");
    expect(ledger).toContain('"atom_id":"adv-sb"');

    const again = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-a");
    expect(again).not.toContain(LINE);
  });

  it("never cuts a compiled group at the advisory budget: it ships whole or not at all", async () => {
    // Every line shares two words with the prompt, so the folder's over-budget set (10 > 8) keeps them
    // all as candidates; the 9-line group still does not fit the budget and ships not at all.
    const group = Array.from({ length: 9 }, (_, i) => ({ ref: `g${i}`, line: `- grouped release checklist line ${i}. [context]`, group: "mem-big" }));
    const { home, hookScript, wsRoot } = await makeHome({
      path_advisories: { "/": [...group, { ref: "solo", line: "- a standalone release checklist advisory. [context]" }] },
    });
    const ctx = await runPrompt(home, hookScript, wsRoot, "Explain how the release checklist works in this repo please.", "sess-b");
    expect(ctx).toContain("- a standalone release checklist advisory. [context]");
    expect(ctx).not.toContain("grouped release checklist line");
  });
});
