// SPDX-License-Identifier: Apache-2.0
// CONSTRAINT v1 end to end, from the authoring surface an agent actually calls down to
// the standalone hook binary that Claude Code runs.
//
// Chain under test:
//   pathrule_write_rule (real MCP tool handler)
//     -> LocalBackend (real storage)
//   pathrule_update_rule (real MCP tool handler) with constraint_intent
//     -> deterministic compiler -> both oracles
//   updateRuleHandler with policy_provenance "explicit" (the human surface)
//     -> AUTO active, no approval call
//   backend.buildHookIndexPayload -> hook-index.json
//     -> real pathrule-hook.js -> PreToolUse deny
//
// Nothing here is a stub: the only thing simulated is the person behind the explicit
// policy claim, which is exactly the thing no agent surface is allowed to assert.

import { removeScratch } from "./scratch.js";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalBackend } from "@pathrule/core";
import { updateRuleHandler } from "@pathrule/core/tools/rules.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import type { StructuredConstraintIntent } from "@pathrule/agent-ir/atoms/constraint-compiler.js";
import { writeRuleTool } from "../tools/write-rule.js";
import { updateRuleTool } from "../tools/update-rule.js";
import { resetLocalBackends } from "../local-runtime.js";

// The hook is a standalone CommonJS script, not a package export, so it is resolved by
// path the same way the installer copies it.
const HOOK_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../integrations/src/hook-supervisor/pathrule-hook.js",
);

/** The rule body a person wrote. Every literal below is quoted from it. */
const BODY = [
  "# Cursor",
  "",
  "Never apply `cursor: pointer` (or the Tailwind `cursor-pointer` class) anywhere in the app UI.",
  "",
  "Use a hover background, colour or opacity change to signal interactivity.",
].join("\n");

const REMEDY = "Use a hover background, colour or opacity change to signal interactivity, not the cursor.";

const INTENT: StructuredConstraintIntent = {
  source_text: "Never apply `cursor: pointer` (or the Tailwind `cursor-pointer` class) anywhere in the app UI.",
  forbidden_forms: [
    { literal: "cursor: pointer", form_kind: "css_declaration" },
    { literal: "cursor-pointer", form_kind: "class_name" },
  ],
  positive_examples: [
    ".cta { cursor: pointer; }",
    'style={{ cursor: "pointer" }}',
    '<div className="flex cursor-pointer items-center">',
  ],
  negative_examples: [
    ".cta { cursor: default; }",
    "const cursorPointer = 1;",
    '<div className="cursor-not-allowed">',
  ],
  message: REMEDY,
};

interface HookOutput {
  reason?: string;
  hookSpecificOutput?: { permissionDecision?: string };
}

function runHook(hookScript: string, home: string, payload: unknown): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      { env: { ...process.env, PATHRULE_HOME: home }, timeout: 20_000 },
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

describe("the agent-facing schema", () => {
  it("accepts a structured intent and offers no way to claim explicit policy", () => {
    for (const tool of [writeRuleTool, updateRuleTool]) {
      const schema = tool.inputSchema as Record<string, unknown>;
      // The claim is not in the wire contract at all, which is the primary control: an
      // agent cannot assert what it cannot send.
      expect(schema["policy_provenance"]).toBeUndefined();
    }
    // write_rule takes the intent at the top level; update_rule nests it under `patch`.
    const writeIntent = (writeRuleTool.inputSchema as { constraint_intent: z.ZodTypeAny })
      .constraint_intent;
    expect(writeIntent.safeParse(INTENT).success).toBe(true);
    // A caller-supplied regex has nowhere to go: the shape has no such field, and an
    // unknown key is dropped rather than honoured.
    const parsed = writeIntent.safeParse({ ...INTENT, pattern: "cursor:.*", flags: "gi" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("pattern");
      expect(parsed.data).not.toHaveProperty("flags");
    }
    // And an unknown form kind is refused at the boundary.
    expect(
      writeIntent.safeParse({
        ...INTENT,
        forbidden_forms: [{ literal: "files_touched", form_kind: "assigned_literal" }],
      }).success,
    ).toBe(false);
  });
});

describe("CONSTRAINT v1: authoring surface to runtime deny", () => {
  it("compiles, activates and denies, and refuses to let the agent grant itself AUTO", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-c1-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-c1-root-"));
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

      const wid = randomUUID();
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
      seed.close();
      await resetLocalBackends();

      // ── 1. the person writes the rule prose through the real MCP tool ──────
      const written = (await writeRuleTool.handler({
        workspace_id: wid,
        node_path: "/",
        name: "Never use cursor pointer",
        content: BODY,
        scope_type: "project",
        priority: "medium",
      } as never)) as { ok?: boolean; id?: string };
      expect(written.ok).not.toBe(false);
      const ruleId = written.id!;
      expect(ruleId).toBeTruthy();

      // ── 2. the agent attaches the structured intent, and tries to self-grant ──
      // `policy_provenance` is cast in deliberately: it is absent from the tool's schema
      // and its Args, so this is the strongest form of the spoof attempt available.
      const attached = (await updateRuleTool.handler({
        workspace_id: wid,
        rule_id: ruleId,
        patch: { constraint_intent: INTENT },
        policy_provenance: "explicit",
      } as never)) as { ok?: boolean };
      expect(attached.ok).not.toBe(false);

      const afterAgent = LocalBackend.openForWorkspace(wid, process.env);
      const agentAtoms = (await afterAgent.readRule(ruleId))?.constraints ?? [];
      afterAgent.close();
      expect(agentAtoms).toHaveLength(1);
      // The compiler ran and both oracles passed, but the atom is a PROPOSAL.
      expect(agentAtoms[0]).toMatchObject({ authority: "inferred", status: "proposed" });

      // Nothing is enforced yet: the projected stub carries no compiled constraint.
      const beforeBackend = LocalBackend.openForWorkspace(wid, process.env);
      const beforeIndex = await beforeBackend.buildHookIndexPayload(wid);
      beforeBackend.close();
      const beforeStub = (beforeIndex?.project_rules ?? []).find((r) => r.id === ruleId);
      expect(beforeStub?.block_pattern).toBeUndefined();
      expect(beforeStub?.enforcement).toBe("advisory");

      // ── 3. the human surface asserts the explicit policy: AUTO, no approval ──
      const backend = LocalBackend.openForWorkspace(wid, process.env);
      const ctx = {
        backend: backend as unknown as ToolContext["backend"],
        userId: "tester",
        workspaceId: wid,
      } as ToolContext;
      const auto = await updateRuleHandler(ctx, {
        rule_id: ruleId,
        patch: { constraint_intent: INTENT },
        policy_provenance: "explicit",
      });
      expect(auto.ok).toBe(true);
      if (!auto.ok) return;
      // The agent's proposal was superseded, not stacked on. `updateRuleHandler` can also
      // return a version conflict, which is not what this call is.
      const autoRule = auto.data as { constraints?: { status?: string; authority?: string }[] };
      const active = (autoRule.constraints ?? []).filter((a) => a.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ authority: "verified", status: "active", approved_by: null });

      // ── 4. an unsafe intent cannot reach AUTO, even from the human surface ──
      const unsafe = await updateRuleHandler(ctx, {
        rule_id: ruleId,
        patch: {
          constraint_intent: {
            ...INTENT,
            // A ban that needs the argument's TYPE, not its spelling.
            forbidden_forms: [{ literal: "cursor", form_kind: "identifier" }],
          },
        },
        policy_provenance: "explicit",
      });
      expect(unsafe.ok).toBe(false);
      if (!unsafe.ok) {
        expect(unsafe.error.detail).toMatchObject({ reason: "NEGATIVE_FALSE_POSITIVE" });
      }
      // The refusal changed nothing: the verified atom is still the active one.
      const stillArmed = (await backend.readRule(ruleId))?.constraints ?? [];
      expect(stillArmed.filter((a) => (a as { status?: string }).status === "active")).toHaveLength(1);

      // ── 5. the projected hook index carries the compiled constraint ──────────
      const index = await backend.buildHookIndexPayload(wid);
      backend.close();
      const stub = (index?.project_rules ?? []).find((r) => r.id === ruleId);
      expect(stub?.enforcement).toBe("strict");
      expect(stub?.block_pattern?.message).toBe(REMEDY);

      // ── 6. the real hook binary denies the edit ─────────────────────────────
      const hookScript = join(home, "bin", "pathrule-hook.js");
      await mkdir(dirname(hookScript), { recursive: true });
      await copyFile(HOOK_SOURCE, hookScript);
      const cacheDir = join(home, "cache", wid);
      await mkdir(cacheDir, { recursive: true });
      // LocalBackend leaves `workspace_root` empty on purpose (local-backend.ts:1859):
      // the surface that writes the file owns the path, so this is what the CLI does.
      await writeFile(
        join(cacheDir, "hook-index.json"),
        JSON.stringify({ ...index, workspace_root: canonicalRoot }),
        "utf8",
      );
      // Edit/Write run the work-conflict guard first; with no snapshot the hook
      // cold-paths to a degraded ask and never reaches the deny.
      await writeFile(
        join(cacheDir, "work-state-snapshot.json"),
        JSON.stringify({
          schema_version: 1,
          workspace_id: wid,
          generated_at: new Date().toISOString(),
          rows_by_path: {},
          display_names_by_user_id: {},
        }),
        "utf8",
      );
      await mkdir(join(canonicalRoot, "src"), { recursive: true });

      const denied = await runHook(hookScript, home, {
        session_id: "c1-e2e",
        cwd: canonicalRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(canonicalRoot, "src", "Card.tsx"),
          old_string: "const a = 1;",
          new_string: 'style={{ cursor: "pointer" }}',
        },
      });
      expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
      // The authored remedy reaches the agent, and the JSX form is the one the model's
      // own regex missed in the feasibility measurement.
      expect(denied.reason).toContain("hover background");

      const allowed = await runHook(hookScript, home, {
        session_id: "c1-e2e-ok",
        cwd: canonicalRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(canonicalRoot, "src", "Card.tsx"),
          old_string: "const a = 1;",
          new_string: 'className="cursor-not-allowed"',
        },
      });
      expect(allowed.hookSpecificOutput?.permissionDecision).toBeUndefined();

      // ── 7. a BYPASS writer rewrites the prose, and the deny stops ───────────
      // `backend.updateRule({ id, content })` with no atom list is verbatim what
      // packages/vscode/src/fs/content-store.ts does when a rule is saved as a file, and
      // what the maintenance proposal applier and its rollback builder do. None of them
      // knows constraints exist, so the stored atom stays verified/active and only the
      // prose moves. The representation was proved against a sentence this body no longer
      // contains, so it must not reach the hook.
      const bypass = LocalBackend.openForWorkspace(wid, process.env);
      await bypass.updateRule({
        id: ruleId,
        content: "# Cursor\n\nPointer cursors are fine now. Use them freely.",
      });
      const staleAtoms = (await bypass.readRule(ruleId))?.constraints ?? [];
      // The atom itself is untouched: this is the state the bug lived in.
      expect(staleAtoms.filter((a) => (a as { status?: string }).status === "active")).toHaveLength(1);
      const afterIndex = await bypass.buildHookIndexPayload(wid);
      bypass.close();
      const afterStub = (afterIndex?.project_rules ?? []).find((r) => r.id === ruleId);
      expect(afterStub?.block_pattern).toBeUndefined();
      expect(afterStub?.enforcement).toBe("advisory");

      await writeFile(
        join(cacheDir, "hook-index.json"),
        JSON.stringify({ ...afterIndex, workspace_root: canonicalRoot }),
        "utf8",
      );
      const noLongerDenied = await runHook(hookScript, home, {
        session_id: "c1-e2e-stale",
        cwd: canonicalRoot,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(canonicalRoot, "src", "Card.tsx"),
          old_string: "const a = 1;",
          new_string: 'style={{ cursor: "pointer" }}',
        },
      });
      expect(noLongerDenied.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    } finally {
      process.chdir(prev.cwd);
      // Assigning undefined stores the string "undefined", and the next suite's host then writes
      // into ./undefined/host inside the package.
      for (const [key, value] of [
        ["PATHRULE_HOME", prev.home],
        ["PATHRULE_LOCAL", prev.local],
        ["PATHRULE_LOCAL_PRINCIPAL", prev.principal],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeScratch(home);
      removeScratch(root);
    }
  }, 60_000);
});
