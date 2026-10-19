// SPDX-License-Identifier: Apache-2.0
// Knowledge under an `_archive` node is history, not context.
//
// Found 2026-10-09: after Studio's knowledge moved to `/_archive/studio`, ordinary prompts still got
// archived bodies as "most relevant", because Claude's body pool is the whole index and an index
// written before the move (or by any writer that did not drop them) carried every archived item. The
// writer drops them now; this pins the hook's own half for an index that still holds them.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "88888888-8888-8888-8888-888888888888";

const MEMS = [
  { id: "m-live", node: "/api", title: "Queue retry policy", body: "LIVE_BODY queue retry twice" },
  {
    id: "m-archived",
    node: "/_archive/studio",
    title: "[Archived: Studio] Queue retry policy",
    body: "ARCHIVED_BODY queue retry in Studio",
  },
  {
    id: "m-nested",
    node: "/api/_archive",
    title: "Old queue retry policy",
    body: "NESTED_ARCHIVED_BODY queue retry",
  },
];

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-archive-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);
  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "api"), { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-10-09T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
      indexed_memory_ids: MEMS.map((m) => m.id),
      path_memories: Object.fromEntries(
        MEMS.map((m) => [
          m.node,
          [{ id: m.id, title: m.title, preview: m.title, node_path: m.node, content_hash: `h-${m.id}` }],
        ]),
      ),
      path_rules: {
        "/_archive/studio": [
          {
            id: "r-archived",
            name: "Archived queue retry rule",
            preview: "queue retry",
            node_path: "/_archive/studio",
            priority: "high",
            enforcement: "advisory",
          },
        ],
      },
      project_rules: [],
      recent_subjects: [],
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        MEMS.map((m) => [m.id, { type: "memory", title: m.title, body: m.body, content_hash: `h-${m.id}` }]),
      ),
    ),
  );
  return { home, hookScript, wsRoot, stub };
}

function prompt(h: Awaited<ReturnType<typeof makeHome>>, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hookScript],
      {
        env: {
          ...process.env,
          HOME: h.home,
          PATHRULE_HOME: h.home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
          PATHRULE_NAVIGATION: "on",
          PATHRULE_EMBED_HELPER: h.stub,
        },
        timeout: 15_000,
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
      JSON.stringify({
        cwd: join(h.wsRoot, "api"),
        session_id: "s-archive",
        hook_event_name: "UserPromptSubmit",
        prompt: text,
      }),
    );
  });
}

describe("archived knowledge through the hook", () => {
  it("delivers the live memory and nothing from an archive node, top-level or nested", async () => {
    const h = await makeHome();
    const out = await prompt(h, "how should the queue retry policy work?");
    expect(out).toContain("LIVE_BODY");
    expect(out).not.toContain("ARCHIVED_BODY");
    expect(out).not.toContain("NESTED_ARCHIVED_BODY");
    expect(out).not.toContain("[Archived: Studio]");
    expect(out).not.toContain("m-archived");
    expect(out).not.toContain("Archived queue retry rule");
  });
});
