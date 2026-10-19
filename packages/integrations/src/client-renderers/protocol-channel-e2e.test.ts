// SPDX-License-Identifier: Apache-2.0
// End to end, one decision: the protocol is carried by EXACTLY ONE channel.
//
// This is the keystone guard for moving the protocol off disk. The two halves
// are written by different code paths (companion files vs the hook index), and
// the dangerous outcome is not duplication, it is zero: a workspace whose
// instruction file no longer states the protocol and whose hook never injects
// it. So this test runs both configurations through the REAL writer and the REAL
// hook script and asserts one-and-only-one delivery in each.

import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";
import { renderProtocolRulesFile } from "../pathrule-protocol.js";
import { syncHookIndex } from "../index-writers/hook-index-writer.js";
import { renderForClients } from "./orchestrator.js";
import { resolveProtocolChannel } from "./protocol-channel.js";
import type { MultiClientInput } from "./types.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "hook-supervisor", "pathrule-hook.js");
const WS = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// A phrase the protocol really contains, so the assertion tracks the protocol
// itself rather than a marker a refactor could quietly drop.
const PROTOCOL_PHRASE = "pathrule_get_context";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

function input(): MultiClientInput {
  return {
    workspaceName: "demo",
    overview: [{ node_id: "n1", relative_path: "/", memories: [], rules: [], skills: [] }],
  };
}

function backend() {
  return {
    refreshWorkEpisodes: async () => ({ ok: true }),
    buildHookIndexPayload: async () => ({
      schema_version: 2,
      workspace_id: WS,
      generated_at: "2026-08-25T00:00:00.000Z",
      workspace_root: null,
      path_memories: {},
      path_rules: {},
      project_rules: [],
      session_digest: "📋 Recent: DIGEST_MARKER",
      recent_subjects: [],
      pending_refresh_count: 0,
    }),
  } as never;
}

async function runHook(home: string, wsRoot: string, sessionId: string): Promise<string> {
  const hookScript = join(home, "bin", "pathrule-hook.js");
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit" },
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
      JSON.stringify({ cwd: wsRoot, prompt: "add a queue retry", session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    );
  });
}

/** Run the whole chain for one hook-install state and report both channels. */
async function deliver(hookInstalled: readonly ("claude-code" | "codex")[]) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-proto-e2e-"));
  homes.push(home);
  await mkdir(join(home, "bin"), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, join(home, "bin", "pathrule-hook.js"));
  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });

  // ONE decision drives both halves.
  const decision = resolveProtocolChannel({ enabled: ["codex"], hookInstalled });

  const rendered = renderForClients(input(), ["codex"], {
    protocolOnHook: decision.signatureClients,
  });
  const diskBody = (rendered.find((r) => r.client === "codex")?.files ?? [])
    .filter((f) => f.path === "AGENTS.md")
    .map((f) => f.body)
    .join("\n");

  const prevHome = process.env.PATHRULE_HOME;
  process.env.PATHRULE_HOME = home;
  try {
    const r = await syncHookIndex({
      backend: backend(),
      workspaceId: WS,
      workspaceRoot: wsRoot,
      env: process.env,
      refreshEpisodes: false,
      protocol: decision.protocolOnIndex ? renderProtocolRulesFile() : undefined,
    });
    expect(r.ok).toBe(true);
  } finally {
    if (prevHome === undefined) delete process.env.PATHRULE_HOME;
    else process.env.PATHRULE_HOME = prevHome;
  }

  const first = await runHook(home, wsRoot, "e2e-session");
  const second = await runHook(home, wsRoot, "e2e-session");
  return { diskBody, first, second, home, wsRoot, decision };
}

describe("protocol channel, end to end", () => {
  it("delivers the protocol on disk and not on the hook when no hook is installed", async () => {
    const d = await deliver([]);
    expect(d.decision.protocolOnIndex).toBe(false);
    expect(d.diskBody).toContain(PROTOCOL_PHRASE);
    expect(d.first).not.toContain(PROTOCOL_PHRASE);
    // Still doing its job, so the absence is not an empty payload.
    expect(d.first).toContain("DIGEST_MARKER");
  });

  it("delivers the protocol on the hook and not on disk when the hook is installed", async () => {
    const d = await deliver(["codex"]);
    expect(d.decision.protocolOnIndex).toBe(true);
    expect(d.diskBody).not.toContain(PROTOCOL_PHRASE);
    // Nothing is written into the person's AGENTS.md at all, not even a signature.
    expect(d.diskBody).toBe("");
    expect(d.first).toContain(PROTOCOL_PHRASE);
  });

  it("says it once per session, not once per prompt", async () => {
    const d = await deliver(["codex"]);
    expect(d.first).toContain(PROTOCOL_PHRASE);
    expect(d.second).not.toContain(PROTOCOL_PHRASE);
  });

  it("never delivers it zero times, in either configuration", async () => {
    for (const installed of [[], ["codex"] as const]) {
      const d = await deliver(installed as never);
      const onDisk = d.diskBody.includes(PROTOCOL_PHRASE);
      const onHook = d.first.includes(PROTOCOL_PHRASE);
      expect([onDisk, onHook].filter(Boolean).length, `installed=${JSON.stringify(installed)}`).toBe(1);
    }
  });
});
