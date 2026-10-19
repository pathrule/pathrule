// SPDX-License-Identifier: Apache-2.0
// Teammate-conflict check on PreToolUse.
//
// The hook asks the cloud extension before a write. Teammates' work state has no source on
// this machine: no local process answers the check and nothing keeps a work-state snapshot,
// so the check is reported as degraded and never interrupts a write.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// The open hook, with the extensions this behaviour needs beside it, the way the official build installs them.
const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const CLOUD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook-cloud.cjs");
const WS_ID = "88888888-8888-4888-8888-888888888888";
const REL = "src/billing/invoice.ts";
const ME = "user-me";
const TEAMMATE = "user-teammate";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-conflicts-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await copyFile(CLOUD_EXTENSION, join(dirname(hookScript), "pathrule-hook-cloud.cjs"));

  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, dirname(REL)), { recursive: true });
  await writeFile(join(wsRoot, REL), "export const total = 1;\n");
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      user_id: ME,
      generated_at: "2026-10-05T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
      path_memories: {},
      path_rules: {
        "/src/billing": [
          {
            id: "r-billing",
            name: "Billing rule",
            preview: "billing rule preview",
            node_path: "/src/billing",
            priority: "high",
            enforcement: "advisory",
            content_hash: "h-r-billing",
          },
        ],
      },
      project_rules: [],
      recent_subjects: [],
    }),
  );
  return { home, hookScript, wsRoot, cacheDir };
}

function teammateRow(patch: Record<string, unknown> = {}) {
  return {
    workspace_id: WS_ID,
    user_id: TEAMMATE,
    runtime_id: "runtime:teammate",
    relative_path: REL,
    is_active: true,
    is_dirty: false,
    git_status: "unknown",
    last_heartbeat_at: new Date().toISOString(),
    last_local_write_at: null,
    last_git_scan_at: new Date().toISOString(),
    ...patch,
  };
}

async function writeSnapshot(cacheDir: string, rows: Record<string, unknown>[]) {
  await writeFile(
    join(cacheDir, "work-state-snapshot.json"),
    JSON.stringify({
      schema_version: 1,
      workspace_id: WS_ID,
      generated_at: new Date().toISOString(),
      active_ttl_ms: 30_000,
      rows_by_path: rows.length > 0 ? { [REL]: rows } : {},
      display_names_by_user_id: { [TEAMMATE]: "Ayşe" },
    }),
  );
}

interface HookOutput {
  decision?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

function runEdit(
  home: string,
  hookScript: string,
  wsRoot: string,
  tool: { tool_name: string; tool_input: Record<string, unknown> } = {
    tool_name: "Edit",
    tool_input: { file_path: join(wsRoot, REL), old_string: "1", new_string: "2" },
  },
  extraEnv: Record<string, string> = {},
): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "PreToolUse",
          ...extraEnv,
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as HookOutput);
        } catch {
          resolve({});
        }
      },
    );
    child.stdin!.end(
      JSON.stringify({
        cwd: wsRoot,
        ...tool,
        session_id: `s-${Math.random().toString(36).slice(2)}`,
        hook_event_name: "PreToolUse",
      }),
    );
  });
}

describe("PreToolUse teammate-conflict check", () => {
  it("passes a write and still delivers path knowledge", async () => {
    const { home, hookScript, wsRoot } = await makeHome();

    const out = await runEdit(home, hookScript, wsRoot);

    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("ask");
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("Billing rule");
  });

  it("does not act on a work-state snapshot or a writer config left on disk by an older install", async () => {
    const { home, hookScript, wsRoot, cacheDir } = await makeHome();
    await writeSnapshot(cacheDir, [teammateRow()]);
    await writeFile(
      join(home, "daemon-hook.json"),
      JSON.stringify({ schema_version: 1, port: 9, token: "old-token" }),
    );

    const out = await runEdit(home, hookScript, wsRoot);

    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("ask");
    expect(out.hookSpecificOutput?.additionalContext ?? "").toContain("Billing rule");
  });
});
