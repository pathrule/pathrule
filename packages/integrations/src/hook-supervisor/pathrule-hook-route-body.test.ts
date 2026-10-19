// SPDX-License-Identifier: Apache-2.0
// Black-box guarantee that the offline UserPromptSubmit hook delivers the
// routed path's full BODIES (from the warehouse), not just a pointer/title — with
// content-hash delta (unchanged topic → silence) and compiled-exclusion (items
// already in the agent's turn-zero files are never double-delivered). This is the
// channel that lets Pathrule reach the agent with NO compiled files and NO MCP.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "22222222-2222-2222-2222-222222222222";
const BODY = "Never use the service_role key in client-facing supabase code; use the anon key with RLS.";
const PROMPT = "In the supabase area, which database key must I avoid and how do RLS policies apply?";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

interface IndexOverrides {
  knowledge_compiled?: boolean;
  compiled_memory_ids?: string[];
  indexed_memory_ids?: string[];
}

async function makeHome(overrides: IndexOverrides = {}): Promise<{ home: string; hookScript: string; wsRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-route-body-"));
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
      path_memories: {
        "/supabase": [
          {
            id: "mem-sb",
            title: "Supabase service_role key",
            preview: "never use service_role key",
            node_path: "/supabase",
            content_hash: "h1",
          },
        ],
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      // Work episode routes the prompt to /supabase with a strong score.
      work_episode_index: [
        { paths: ["/supabase"], subjects: ["supabase", "rls", "key"], summary: "supabase access rules" },
      ],
      ...overrides,
    }),
  );

  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify({
      "mem-sb": { type: "memory", title: "Supabase service_role key", body: BODY, content_hash: "h1" },
    }),
  );

  return { home, hookScript, wsRoot };
}

function runPrompt(
  home: string,
  hookScript: string,
  wsRoot: string,
  prompt: string,
  sessionId: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
          PATHRULE_NAVIGATION: "on",
          ...extraEnv,
        },
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "");
        } catch {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin!.end(
      JSON.stringify({ cwd: wsRoot, prompt, session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    );
  });
}

describe("offline hook × routed-path body injection", () => {
  it("delivers the routed memory's FULL body on the first prompt", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-a");
    expect(ctx).toContain(BODY); // the body itself, not just the title
    expect(ctx).toContain("Supabase service_role key");
  });

  // Studio set this flag on the engines it spawned so the hook stood down; Studio is gone, and a
  // leftover flag in someone's environment must not silence the only channel left.
  it("ignores the retired Studio stand-down flag", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-studio", {
      PATHRULE_STUDIO_CONTEXT_INJECTED: "1",
    });
    expect(ctx).toContain(BODY);
  });

  it("stays silent on a repeat of the same topic (content-hash delta)", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const first = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-b");
    expect(first).toContain(BODY);
    // Same topic again → route signature unchanged AND body already delivered →
    // the body must NOT be re-injected (the cache-beating delta behavior).
    const second = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-b");
    expect(second).not.toContain(BODY);
  });

  it("slim: delivers the body of a title-indexed memory (router file holds only the title)", async () => {
    // Under the slim router render (Claude), the per-dir file carries the memory
    // TITLE only (indexed_memory_ids), NOT the body — so the hook IS the body
    // channel and must deliver it. This INVERTS the old full-mode contract where
    // compiled_memory_ids meant "body already in the file → skip".
    const { home, hookScript, wsRoot } = await makeHome({
      knowledge_compiled: true,
      indexed_memory_ids: ["mem-sb"],
    });
    const ctx = await runPrompt(home, hookScript, wsRoot, PROMPT, "sess-c");
    expect(ctx).toContain(BODY); // body delivered — it is not in the slim file
  });
});
