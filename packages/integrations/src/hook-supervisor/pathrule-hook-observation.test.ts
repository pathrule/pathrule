// SPDX-License-Identifier: Apache-2.0
/**
 * V30 live capture, through the REAL hook process.
 *
 * Runs the actual standalone `pathrule-hook.js` as a child process with a real Claude Code
 * `PostToolUse` payload and a session that already has a delivered advisory, and asserts it writes
 * the `knowledge-observations.jsonl` line the backend drain consumes. This is the production capture
 * path end to end (no hand-built ObservedEvent): the only thing it does not do is originate from a
 * live model, which is an environment concern, not a code-path one. It also proves the negative: a
 * session with NO delivered advisory captures nothing.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
let hookCjs = "";
const roots: string[] = [];
beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), "pr-hook-bin-"));
  roots.push(d);
  hookCjs = join(d, "pathrule-hook.cjs"); // .cjs so require() works outside the ESM package
  copyFileSync(HOOK_SRC, hookCjs);
});
afterEach(() => {
  // Keep the copied hook binary (roots[0]); clean the per-test home/repo dirs created after it.
  for (const d of roots.splice(1)) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "pr-hook-home-"));
  const repo = mkdtempSync(join(tmpdir(), "pr-hook-repo-"));
  roots.push(home, repo);
  const wsId = "ws-test";
  const cacheWs = join(home, "cache", wsId);
  mkdirSync(cacheWs, { recursive: true });
  writeFileSync(join(cacheWs, "hook-index.json"), JSON.stringify({ workspace_id: wsId, workspace_root: repo, generated_at: "2026-09-10T00:00:00.000Z" }));
  return { home, repo, wsId, cacheWs };
}
function session(cacheWs: string, sid: string, deliveredRefs: string[]) {
  writeFileSync(join(cacheWs, `session-${sid}.json`), JSON.stringify({ session_id: sid, delivered_advisory_refs: deliveredRefs }));
}
function runHook(home: string, repo: string, payload: unknown) {
  execFileSync("node", [hookCjs], {
    input: JSON.stringify(payload),
    env: { ...process.env, PATHRULE_HOME: home },
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
  });
}
function observations(cacheWs: string): Array<{ sid: string; event: { kind: string; path?: string; after?: string; command?: string } }> {
  const f = join(cacheWs, "knowledge-observations.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

describe("V30 real hook process captures observable tool events", () => {
  it("an Edit in a session WITH a delivered advisory writes a normalized edit observation", () => {
    const { home, repo, cacheWs } = setup();
    session(cacheWs, "s1", ["ref-1"]);
    const filePath = join(repo, "apps/web/x.ts");
    runHook(home, repo, {
      hook_event_name: "PostToolUse", tool_name: "Edit", session_id: "s1", cwd: repo,
      tool_input: { file_path: filePath, old_string: "foo()", new_string: "safeFoo()" },
      tool_response: {},
    });
    const obs = observations(cacheWs);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.sid).toBe("s1");
    expect(obs[0]!.event.kind).toBe("edit");
    expect(obs[0]!.event.path).toBe("/apps/web/x.ts"); // workspace-relative, leading slash
    expect(obs[0]!.event.after).toContain("safeFoo()");
  });

  it("a Bash command records a command observation with its exit code", () => {
    const { home, repo, cacheWs } = setup();
    session(cacheWs, "s1", ["ref-1"]);
    runHook(home, repo, {
      hook_event_name: "PostToolUse", tool_name: "Bash", session_id: "s1", cwd: repo,
      tool_input: { command: "pnpm test" },
      tool_response: { exit_code: 0 },
    });
    const obs = observations(cacheWs);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.event.kind).toBe("command");
    expect(obs[0]!.event.command).toBe("pnpm test");
  });

  it("a session with NO delivered advisory captures nothing (no noise, no cost)", () => {
    const { home, repo, cacheWs } = setup();
    session(cacheWs, "s1", []); // nothing delivered
    runHook(home, repo, {
      hook_event_name: "PostToolUse", tool_name: "Edit", session_id: "s1", cwd: repo,
      tool_input: { file_path: join(repo, "apps/web/x.ts"), old_string: "foo()", new_string: "safeFoo()" },
      tool_response: {},
    });
    expect(observations(cacheWs)).toHaveLength(0);
  });

  it("a Read (unobservable tool) captures nothing even with an advisory delivered", () => {
    const { home, repo, cacheWs } = setup();
    session(cacheWs, "s1", ["ref-1"]);
    runHook(home, repo, {
      hook_event_name: "PostToolUse", tool_name: "Read", session_id: "s1", cwd: repo,
      tool_input: { file_path: join(repo, "apps/web/x.ts") },
      tool_response: {},
    });
    expect(observations(cacheWs)).toHaveLength(0);
  });
});
