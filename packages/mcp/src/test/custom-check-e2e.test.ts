// SPDX-License-Identifier: Apache-2.0
// A custom CHECK command end to end, from the tool an agent calls to the hook binary.
//
// Chain under test:
//   pathrule_write_rule (real MCP tool handler) with an unfamiliar exact-argv command
//     -> LocalBackend (real storage), stored inferred + proposed
//   backend.buildHookIndexPayload -> hook-index.json -> real pathrule-hook.js
//     -> the proposal holds nothing open
//   approveRuleCheckHandler (the human approval) -> required_check in the index
//     -> an in-scope edit arms it, Stop holds the turn and names the exact command
//     -> only a confirmed pass of the exact argv, run by the agent, clears it
//
// The command is also a real executable on the hook's PATH that records every launch, so
// the test proves Pathrule never runs it: the agent runs it, Pathrule only reads the result.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { approveRuleCheckHandler } from "@pathrule/core/tools/rules.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { writeRuleTool } from "../tools/write-rule.js";
import { resetLocalBackends } from "../local-runtime.js";

const HOOK_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations/src/hook-supervisor/pathrule-hook.js",
);
const BINARY = "northstar-check";
const COMMAND = `${BINARY} audit --strict`;
const MESSAGE = "Run the project audit before finishing work under /services.";

interface HookOutput {
  decision?: string;
  reason?: string;
}

function runHook(hookScript: string, home: string, pathPrefix: string, payload: unknown): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: { ...process.env, PATHRULE_HOME: home, PATH: `${pathPrefix}${delimiter}${process.env.PATH ?? ""}` },
        timeout: 20_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        if (error?.killed) {
          reject(new Error("hook timed out"));
          return;
        }
        const trimmed = stdout.trim();
        resolve(trimmed ? (JSON.parse(trimmed) as HookOutput) : {});
      },
    );
    child.stdin?.end(JSON.stringify(payload));
  });
}

afterEach(async () => {
  await resetLocalBackends();
});

describe("custom CHECK: agent proposes, a person approves, the agent runs it", () => {
  it("stays inert until approved, then clears only on the exact argv, and is never executed by Pathrule", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-cc-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-cc-root-"));
    const prev = {
      home: process.env.PATHRULE_HOME,
      local: process.env.PATHRULE_LOCAL,
      principal: process.env.PATHRULE_LOCAL_PRINCIPAL,
      cwd: process.cwd(),
    };
    try {
      process.env.PATHRULE_HOME = home;
      process.env.PATHRULE_LOCAL = "1";
      process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";
      process.chdir(root);
      const canonicalRoot = process.cwd();

      // A real executable with the command's name. Any launch leaves a marker.
      const fakeBin = join(home, "fake-bin");
      const marker = join(home, "custom-check-was-executed");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, BINARY), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 0\n`, "utf8");
      await chmod(join(fakeBin, BINARY), 0o755);

      const wid = randomUUID();
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
      seed.close();
      await resetLocalBackends();

      // ── 1. the agent proposes the rule and its custom check ────────────────
      const written = (await writeRuleTool.handler({
        workspace_id: wid,
        node_path: "/",
        name: "Audit services before finishing",
        content: "# Audit\n\nRun `northstar-check audit --strict` after changing anything under /services.",
        scope_type: "project",
        priority: "medium",
        check: { scope_path: "/services", command: COMMAND, message: MESSAGE },
      } as never)) as { ok?: boolean; id?: string };
      expect(written.ok).toBe(true);
      const ruleId = written.id!;
      // The response shape is the one every write_rule caller already reads.
      expect(Object.keys(written).sort()).toEqual(["created_at", "human_message", "id", "name", "ok"]);

      const backend = LocalBackend.openForWorkspace(wid, process.env);
      const atoms = (await backend.readRule(ruleId))?.constraints ?? [];
      expect(atoms).toHaveLength(1);
      expect(atoms[0]).toMatchObject({
        kind: "check",
        authority: "inferred",
        status: "proposed",
        approved_by: null,
        requires: { kind: "command", command: COMMAND },
      });
      const checkId = (atoms[0] as { id: string }).id;
      const fingerprint = (atoms[0] as { requires: { fingerprint: string } }).requires.fingerprint;
      expect(fingerprint).toMatch(/^opaque\.v1:[0-9a-f]{64}$/);

      // ── 2. the proposal is never delivered as an approved requirement ───────
      const writeIndex = async () => {
        const index = await backend.buildHookIndexPayload(wid);
        const cacheDir = join(home, "cache", wid);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(join(cacheDir, "hook-index.json"), JSON.stringify({ ...index, workspace_root: canonicalRoot }), "utf8");
        await writeFile(
          join(cacheDir, "work-state-snapshot.json"),
          JSON.stringify({ schema_version: 1, workspace_id: wid, generated_at: new Date().toISOString(), rows_by_path: {}, display_names_by_user_id: {} }),
          "utf8",
        );
        return (index?.project_rules ?? []).find((r) => r.id === ruleId);
      };
      const hookScript = join(home, "bin", "pathrule-hook.js");
      await mkdir(dirname(hookScript), { recursive: true });
      await copyFile(HOOK_SOURCE, hookScript);
      await mkdir(join(canonicalRoot, "services", "orders"), { recursive: true });
      const hook = (payload: Record<string, unknown>, session: string) =>
        runHook(hookScript, home, fakeBin, { cwd: canonicalRoot, session_id: session, ...payload });
      const edit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(canonicalRoot, "services", "orders", "a.ts"), old_string: "a", new_string: "b" } };
      const stop = { hook_event_name: "Stop" };
      const bash = (command: string, exitCode: number) => ({
        hook_event_name: exitCode === 0 ? "PostToolUse" : "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: exitCode === 0 ? { is_error: false, stdout: "ok", exit_code: 0 } : { is_error: true, exit_code: exitCode },
      });

      expect((await writeIndex())?.required_check).toBeUndefined();
      await hook(edit, "cc-proposed");
      expect((await hook(stop, "cc-proposed")).decision).toBeUndefined();

      // ── 3. approval needs the explicit confirmation, then a person grants it ──
      const ctx = { backend: backend as unknown as ToolContext["backend"], userId: "reviewer", workspaceId: wid } as ToolContext;
      const unconfirmed = await approveRuleCheckHandler(ctx, { rule_id: ruleId, check_id: checkId } as never);
      expect(unconfirmed.ok).toBe(false);
      expect((await writeIndex())?.required_check).toBeUndefined();

      const approved = await approveRuleCheckHandler(ctx, { rule_id: ruleId, check_id: checkId, confirm: true });
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.data.constraints?.[0]).toMatchObject({ authority: "human", status: "active", approved_by: "reviewer" });

      const stub = await writeIndex();
      expect(stub?.required_check).toEqual({ scope_path: "/services", command: COMMAND, fingerprint, message: MESSAGE });

      // ── 4. an in-scope edit arms it; Stop names the exact command ──────────
      const session = "cc-approved";
      await hook(edit, session);
      const held = await hook(stop, session);
      expect(held.decision).toBe("block");
      expect(held.reason).toContain(MESSAGE);
      expect(held.reason).toContain("Run: `" + COMMAND + "`");

      // ── 5. near misses, a failure and shell forms never clear it ──────────
      for (const other of [`${BINARY} audit`, `${BINARY} audit --relaxed`, `${BINARY} --strict audit`, `${COMMAND} | tail -1`, `${COMMAND} && true`, `nohup ${COMMAND}`, `sh -c '${COMMAND}'`]) {
        await hook(bash(other, 0), session);
        expect((await hook(stop, session)).decision, other).toBe("block");
      }
      await hook(bash(COMMAND, 1), session);
      expect((await hook(stop, session)).decision).toBe("block");

      // ── 6. the agent's confirmed pass of the exact argv clears it ─────────
      await hook(bash(COMMAND, 0), session);
      expect((await hook(stop, session)).decision).toBeUndefined();

      // A later failed rerun owes it again: the last result wins.
      await hook(bash(COMMAND, 1), session);
      expect((await hook(stop, session)).decision).toBe("block");
      backend.close();

      // Every step above ran the hook with the command's binary first on PATH. None of
      // them launched it.
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.chdir(prev.cwd);
      for (const [key, value] of [
        ["PATHRULE_HOME", prev.home],
        ["PATHRULE_LOCAL", prev.local],
        ["PATHRULE_LOCAL_PRINCIPAL", prev.principal],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
