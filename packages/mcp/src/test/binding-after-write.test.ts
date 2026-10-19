// SPDX-License-Identifier: Apache-2.0
// A decision an agent saves in a session is in force from the next prompt, as an edit to a CLAUDE.md is.
// Measured on PathruleBench v2 (2026-10-15): a local write refreshed only the hook index, which then
// took the new memory for one Claude's path-scoped rules carried, while the rule files still held the
// seed. The decision reached neither channel. Through the real tools, on a real store and filesystem.
import { removeScratch } from "./scratch.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { ensureClaudeSettingsHook } from "@pathrule/integrations/pathrule-protocol.js";
import { __resetHookCommandForTests, setHookCommand } from "@pathrule/integrations/hook-supervisor/hook-command.js";
import { writeMemoryTool } from "../tools/write-memory.js";
import { updateMemoryTool } from "../tools/update-memory.js";
import { resetLocalBackends } from "../local-runtime.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());
afterEach(async () => {
  await resetLocalBackends();
});

const KEYS = ["PATHRULE_HOME", "PATHRULE_LOCAL", "PATHRULE_LOCAL_PRINCIPAL"] as const;

async function inWorkspace(rulesFolder: boolean, body: (w: { wid: string; root: string; home: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pathrule-bind-home-"));
  const root = mkdtempSync(join(tmpdir(), "pathrule-bind-root-"));
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
    // What a sync leaves behind: the Claude hook, the hook index, and (signature mode) the rules folder.
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), ensureClaudeSettingsHook(null).body);
    if (rulesFolder) mkdirSync(join(root, ".claude", "rules", "pathrule"), { recursive: true });
    mkdirSync(join(home, "cache", wid), { recursive: true });
    writeFileSync(join(home, "cache", wid, "hook-index.json"), JSON.stringify({ workspace_id: wid, workspace_root: process.cwd() }));
    await body({ wid, root, home });
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

const read = (p: string) => readFileSync(p, "utf8");

// Each case opens stores and renders a workspace; Windows takes well over the 5 s default.
describe("a decision saved in a session", { timeout: 30_000 }, () => {
  it("is in Claude's rules, and the hook index agrees with the files, after write and after update", async () => {
    await inWorkspace(true, async ({ wid, root, home }) => {
      const workspaceFile = join(root, ".claude", "rules", "pathrule", "workspace.md");
      const manifest = () => JSON.parse(read(join(root, ".claude", "rules", "pathrule", "manifest.json"))).memories as Record<string, string>;
      const index = () => JSON.parse(read(join(home, "cache", wid, "hook-index.json"))).instruction_memory_hashes as Record<string, string>;

      const written = (await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/",
        title: "Error type domain",
        content: "Error types use https://errors.acme.dev/ as their base.",
        atoms: [{ kind: "context", fact: ["Error types use https://errors.acme.dev/ as their base."] }],
      } as never)) as { ok?: boolean; id: string };
      expect(written.ok).not.toBe(false);
      expect(read(workspaceFile)).toContain("https://errors.acme.dev/");
      expect(manifest()[written.id]).toBeTruthy();
      expect(index()[written.id]).toBe(manifest()[written.id]);

      const before = manifest()[written.id];
      const updated = (await updateMemoryTool.handler({
        memory_id: written.id,
        content: "Error types created from now on use https://errors.acme.io/ as their base.",
        atoms: [{ kind: "context", fact: ["Error types created from now on use https://errors.acme.io/ as their base."] }],
      } as never)) as { ok?: boolean };
      expect(updated.ok).not.toBe(false);
      expect(read(workspaceFile)).toContain("https://errors.acme.io/");
      expect(read(workspaceFile)).not.toContain("https://errors.acme.dev/");
      expect(manifest()[written.id]).not.toBe(before);
      expect(index()[written.id]).toBe(manifest()[written.id]);
    });
  });

  it("is in Claude's rules when the agent saved it without atoms, and outranks older knowledge for the root's budget", async () => {
    await inWorkspace(true, async ({ wid, root }) => {
      // Older reference that fills the root file's budget on its own.
      for (let i = 0; i < 24; i += 1) {
        const content = `Reference note ${i}: ${"background ".repeat(30).trim()}.`;
        await writeMemoryTool.handler({ workspace_id: wid, node_path: "/", title: `Reference ${i}`, content, atoms: [{ kind: "context", fact: [content] }] } as never);
      }
      const lesson = (await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/",
        title: "Running the team suite",
        content: "Run the team suite as `ACME_TEAM_SUITE=1 go test ./acmetest`; without it TestMain panics.",
      } as never)) as { ok?: boolean; human_message: string };
      expect(lesson.ok).not.toBe(false);
      expect(lesson.human_message).not.toMatch(/atom/i);
      const file = read(join(root, ".claude", "rules", "pathrule", "workspace.md"));
      expect(file).toContain("ACME_TEAM_SUITE=1 go test ./acmetest");
      expect(file).toContain("omitted for size");
    });
  });

  it("is in Claude's rules when every atom the agent sent was refused", async () => {
    await inWorkspace(true, async ({ wid, root }) => {
      // The title quoted as a span: not in the body, so refused, as agents did with this lesson.
      const r = (await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/",
        title: "Run the acmetest team suite",
        content: "The `acmetest` package panics unless `ACME_TEAM_SUITE=1` is set. Run it with `ACME_TEAM_SUITE=1 go test ./acmetest`.",
        atoms: [{ kind: "procedure", operation: ["Run the acmetest team suite"], steps: ["ACME_TEAM_SUITE=1 go test ./acmetest"] }],
      } as never)) as { atoms?: { accepted: number; refused: unknown[] } };
      expect(r.atoms).toMatchObject({ accepted: 0 });
      expect(r.atoms!.refused.length).toBe(1);
      expect(read(join(root, ".claude", "rules", "pathrule", "workspace.md"))).toContain("Run it with `ACME_TEAM_SUITE=1 go test ./acmetest`");
    });
  });

  it("carries a lesson an ended turn's commands taught into Claude's rules at the next sync", async () => {
    await inWorkspace(true, async ({ wid, root, home }) => {
      // What the hook leaves when a turn ends: the transcript, where a piped failure hid its exit code.
      const transcript = join(home, "session.jsonl");
      const step = (id: string, cmd: string, out: string) => [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] } }),
      ];
      writeFileSync(transcript, [...step("a", "go test ./acmetest 2>&1 | tail", "panic: team environment not prepared"), ...step("b", "ACME_TEAM_SUITE=1 go test ./acmetest", "ok  acmetest 0.3s")].join("\n"));
      writeFileSync(join(home, "cache", wid, "ended-turns.jsonl"), `${JSON.stringify({ sid: "s1", transcript })}\n`);
      // Any write syncs the index, which takes in what ended turns taught.
      await writeMemoryTool.handler({ workspace_id: wid, node_path: "/", title: "Unrelated", content: "Something else entirely." } as never);
      expect(read(join(root, ".claude", "rules", "pathrule", "workspace.md"))).toContain("needs `ACME_TEAM_SUITE=1`");
    });
  });

  it("is in Claude's rules sentence by sentence when its first paragraph is too long for one span", async () => {
    await inWorkspace(true, async ({ wid, root }) => {
      const padding = "The catalogue review happens weekly and the reviewers are listed in the platform handbook under the API section. ".repeat(4);
      await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/",
        title: "Error type domain",
        content: `Error types created from now on use https://errors.acme.io/ as their base. Existing ones keep https://errors.acme.dev/ for now. ${padding}`,
      } as never);
      const file = read(join(root, ".claude", "rules", "pathrule", "workspace.md"));
      expect(file).toContain("created from now on use https://errors.acme.io/");
      expect(file).toContain("Existing ones keep https://errors.acme.dev/");
    });
  });

  it("adds no rule files to a project that has none", async () => {
    await inWorkspace(false, async ({ wid, root }) => {
      await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/",
        title: "SPDX line",
        content: "Every new .go file starts with an SPDX line.",
        atoms: [{ kind: "context", fact: ["Every new .go file starts with an SPDX line."] }],
      } as never);
      expect(existsSync(join(root, ".claude", "rules", "pathrule"))).toBe(false);
    });
  });
});
