// SPDX-License-Identifier: Apache-2.0
// A memory's secondary context links (relatedPaths) reach the real hook.
//
// The index comes from core's own assembler, so this pins the whole offline path: a memory owned
// at /docs and linked to /packages/web is named on an edit under /packages/web, it is named ONCE
// on a file its owner and a link both cover, it is not named on an unrelated file, and the
// session ledger keeps it silent on the next edit until its body changes. The hook reads
// `path_memories` by ancestor and deduplicates by id, so no hook change was needed: one stub,
// placed under every path, naming its owner.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleHookIndex,
  assembleWarehouse,
  type HookIndexInput,
} from "@pathrule/core/backend/hook-index.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "88888888-8888-8888-8888-888888888888";
const MEM_ID = "m-linked";
// Named so it shares tokens with the edited files ("checkout", "form"): the name channel
// admits on overlap, and the test is about WHERE it is offered, not whether it scores.
const TITLE = "Checkout form validation contract";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

function inputFor(content: string): HookIndexInput {
  return {
    workspaceId: WS_ID,
    generatedAt: "2026-10-08T00:00:00.000Z",
    memories: [
      {
        id: MEM_ID,
        title: TITLE,
        content,
        node_path: "/docs",
        related_paths: ["/packages/web", "/packages/web/checkout"],
      },
    ],
    rules: [],
    skills: [],
    recentActivitySubjects: [],
    recentActivityDigest: [],
    workEpisodes: [],
    pendingRefreshCount: 0,
    inProgressRefreshCount: 0,
  };
}

async function writeIndex(home: string, wsRoot: string, content: string): Promise<void> {
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  const input = inputFor(content);
  const index = { ...assembleHookIndex(input), workspace_root: wsRoot, knowledge_compiled: true };
  await writeFile(join(cacheDir, "hook-index.json"), JSON.stringify(index));
  await writeFile(join(cacheDir, "warehouse.json"), JSON.stringify(assembleWarehouse(input)));
}

async function makeHome(): Promise<{ home: string; hookScript: string; wsRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-links-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const wsRoot = join(home, "project");
  for (const rel of ["packages/web/checkout/form.tsx", "packages/api/checkout/form.ts"]) {
    await mkdir(join(wsRoot, dirname(rel)), { recursive: true });
    await writeFile(join(wsRoot, rel), "export const form = 1;\n");
  }
  await writeIndex(home, wsRoot, "Validate every checkout form field on submit.");
  return { home, hookScript, wsRoot };
}

function runEdit(
  home: string,
  hookScript: string,
  wsRoot: string,
  rel: string,
  sessionId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "PreToolUse" },
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
        cwd: wsRoot,
        tool_name: "Edit",
        tool_input: { file_path: join(wsRoot, rel), old_string: "1", new_string: "2" },
        session_id: sessionId,
        hook_event_name: "PreToolUse",
      }),
    );
  });
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("secondary context links in the hook", () => {
  it("names a linked memory under its link, once, though two placements cover the file", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    // /packages/web and /packages/web/checkout are both ancestors of this file.
    const out = await runEdit(home, hookScript, wsRoot, "packages/web/checkout/form.tsx", "s-link");
    expect(out).toContain(TITLE);
    expect(occurrences(out, `id: ${MEM_ID}`)).toBe(1);
  });

  it("does not name it where neither its owner nor a link applies", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const out = await runEdit(
      home,
      hookScript,
      wsRoot,
      "packages/api/checkout/form.ts",
      "s-elsewhere",
    );
    expect(out).not.toContain(TITLE);
  });

  it("stays silent on the next edit in the session, and returns when its body changes", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const rel = "packages/web/checkout/form.tsx";
    expect(await runEdit(home, hookScript, wsRoot, rel, "s-delta")).toContain(TITLE);
    expect(await runEdit(home, hookScript, wsRoot, rel, "s-delta")).not.toContain(TITLE);

    await writeIndex(home, wsRoot, "Validate every checkout form field on submit and on blur.");
    expect(await runEdit(home, hookScript, wsRoot, rel, "s-delta")).toContain(TITLE);
  });
});
