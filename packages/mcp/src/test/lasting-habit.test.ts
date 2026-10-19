// SPDX-License-Identifier: Apache-2.0
// A habit the person states as lasting reaches the next session's agent, whatever that prompt says.
// Measured on PathruleBench v2 (2026-10-15): "a habit of mine: every new test function has a comment
// line" stayed a candidate no agent saw, and "Add tests for it." in a later session shares one word with
// it, which no topic gate passes. Through the real tool, index writer and hook.
import { removeScratch } from "./scratch.js";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { rememberPreferenceTool } from "../tools/remember-preference.js";
import { resetLocalBackends } from "../local-runtime.js";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const KEYS = ["PATHRULE_HOME", "PATHRULE_LOCAL", "PATHRULE_LOCAL_PRINCIPAL"] as const;
const SAID = "Add tests for the deadline. By the way, a habit of mine: every new test function has a comment line directly above it saying what it checks.";

afterEach(async () => {
  await resetLocalBackends();
});

function prompt(home: string, root: string, sessionId: string, text: string): string {
  const out = execFileSync(process.execPath, [join(home, "bin", "pathrule-hook.js")], {
    env: { ...process.env, PATHRULE_HOME: home, PATHRULE_HOOK_EVENT: "UserPromptSubmit" },
    input: JSON.stringify({ cwd: root, session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text }),
    encoding: "utf8",
    timeout: 10_000,
  });
  try {
    return JSON.parse(out.trim())?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return out;
  }
}

describe("a habit the person states as lasting", () => {
  // It runs the hook process several times; Windows starts processes several times slower than POSIX.
  it("is delivered in the next session on a prompt that barely names it, once, and only when stated as lasting", { timeout: 30_000 }, async () => {
    for (const lasting of [true, false]) {
      const home = mkdtempSync(join(tmpdir(), "pathrule-habit-home-"));
      const root = mkdtempSync(join(tmpdir(), "pathrule-habit-root-"));
      const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      const cwd = process.cwd();
      try {
        process.env.PATHRULE_HOME = home;
        process.env.PATHRULE_LOCAL = "1";
        process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";
        process.chdir(root);
        const wid = randomUUID();
        const seed = LocalBackend.openForWorkspace(wid, process.env);
        seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: process.cwd() });
        seed.close();
        await resetLocalBackends();
        const cache = join(home, "cache", wid);
        mkdirSync(cache, { recursive: true });
        writeFileSync(join(cache, "hook-index.json"), JSON.stringify({ workspace_id: wid, workspace_root: process.cwd() }));
        // The hook's private record of what the person typed, which the quote is proved against.
        writeFileSync(join(cache, "user-words.jsonl"), `${JSON.stringify({ sid: "s1", at: "2026-10-15T00:00:00.000Z", text: SAID })}\n`);
        mkdirSync(join(home, "bin"), { recursive: true });
        copyFileSync(HOOK, join(home, "bin", "pathrule-hook.js"));

        const r = (await rememberPreferenceTool.handler({
          workspace_id: wid,
          kind: "procedure",
          claim: "Put a comment line directly above every new test function saying what it checks.",
          quotes: ["every new test function has a comment line directly above it saying what it checks"],
          ...(lasting ? { lasting: true } : {}),
        } as never)) as { ok?: boolean; status?: string };
        expect(r).toMatchObject({ ok: true, status: lasting ? "active" : "candidate" });

        const index = JSON.parse(readFileSync(join(cache, "hook-index.json"), "utf8"));
        expect((index.user_preferences ?? []).length).toBe(lasting ? 1 : 0);
        const first = prompt(home, process.cwd(), "s4", "Add tests for it.");
        expect(first.includes("comment line directly above every new test function")).toBe(lasting);
        if (lasting) expect(prompt(home, process.cwd(), "s4", "Run the team suite.")).not.toContain("comment line directly above");
      } finally {
        process.chdir(cwd);
        for (const k of KEYS) {
          if (prev[k] === undefined) delete process.env[k];
          else process.env[k] = prev[k];
        }
        removeScratch(home);
        removeScratch(root);
      }
    }
  });
});
