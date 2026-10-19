// SPDX-License-Identifier: Apache-2.0
/**
 * The learning loop end to end with NO engine installed, through the real store, the real index
 * writer and the real standalone hook process:
 *
 *   an agent types what a memory teaches (captureGroundedAtom) -> the store activates it as GROUNDED
 *   -> the hook index carries it -> PreToolUse on a file under that path delivers it and records the
 *   delivery -> PostToolUse captures the agent's edit -> the drain attributes the use -> a source
 *   rewrite that drops the evidence silences the atom.
 *
 * No model is called anywhere on this path.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBackend } from "@pathrule/core";
import { captureGroundedAtom } from "@pathrule/agent-ir/atoms/grounded-capture.js";
import { syncHookIndex } from "../index-writers/hook-index-writer.js";

const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS = "44444444-4444-4444-4444-444444444444";
// A real memory says more than its atom: the completeness gate delivers it as written, and the
// REMEDY must still reach the edit as typed guidance.
const BODY = "The billing gateway answers 204 with an empty body on retries, and the invoice cache keys on the request id. When `pnpm build` fails with E_EMPTY_BODY on the API client, wrap the parse in `safeParse()`; that fixed it. The handler lives in src/client.ts and is owned by the payments team.";
const roots: string[] = [];
let hook = "";

beforeAll(() => {
  const bin = mkdtempSync(join(tmpdir(), "pr-loop-bin-"));
  roots.push(bin);
  hook = join(bin, "pathrule-hook.cjs");
  copyFileSync(HOOK_SRC, hook);
});
afterEach(() => {
  for (const d of roots.splice(1)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function runHook(env: NodeJS.ProcessEnv, repo: string, event: "PreToolUse" | "PostToolUse", payload: Record<string, unknown>): string {
  return execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: event, cwd: repo, ...payload }),
    env: { ...env, PATHRULE_HOOK_EVENT: event },
    cwd: repo,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("engineless learning loop", () => {
  it("captures, delivers, observes and silences a grounded atom with no engine and no model", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-loop-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-loop-repo-"));
    roots.push(home, repo);
    const env = { ...process.env, PATHRULE_HOME: home };
    const cache = join(home, "cache", WS);

    const store = LocalBackend.openForWorkspace(WS, env);
    try {
      store.registerWorkspace({ workspaceId: WS, localRootPath: repo });
      const node = await store.ensureNodeForPath(WS, "/apps/web", "folder");
      const memory = await store.writeMemory({ workspaceId: WS, nodeId: node.id, title: "Empty API bodies", content: BODY });

      // 1. Capture: the agent quotes the memory; the machine proves the quotes.
      const captured = captureGroundedAtom(
        { kind: "remedy", condition: ["`pnpm build` fails with E_EMPTY_BODY"], action: ["`safeParse()`"] },
        { kind: "memory", id: memory.id, title: memory.title, content: memory.content },
        "2026-10-15T00:00:00.000Z",
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      expect(await store.recordGroundedAtom(WS, captured.atom)).toBe("activated");

      // 2. Index: the grounded atom is an advisory under the memory's path.
      await syncHookIndex({ backend: store as never, workspaceId: WS, workspaceRoot: repo, env, refreshEpisodes: false });
      const index = JSON.parse(readFileSync(join(cache, "hook-index.json"), "utf8")) as { path_advisories?: Record<string, Array<{ ref: string; line: string }>> };
      expect(index.path_advisories?.["/apps/web"]?.map((a) => a.ref)).toContain(captured.atom.id);

      // 3. Delivery: PreToolUse on a file under that path puts it in front of the agent and records it.
      const edit = { file_path: join(repo, "apps/web/client.ts"), old_string: "parse(body)", new_string: "safeParse(body)" };
      const pre = runHook(env, repo, "PreToolUse", { tool_name: "Edit", session_id: "s1", tool_input: edit });
      expect(pre).toContain("safeParse()");
      expect(readFileSync(join(cache, "remedy-deliveries.jsonl"), "utf8")).toContain(captured.atom.id);

      // 4. Observation: the agent's edit is captured, drained and attributed.
      runHook(env, repo, "PostToolUse", { tool_name: "Edit", session_id: "s1", tool_input: edit, tool_response: {} });
      const obs = join(cache, "knowledge-observations.jsonl");
      expect(existsSync(obs)).toBe(true);
      expect(await store.ingestObservationsFromDisk(WS, obs)).toEqual({ observed: 1, skipped: 0 });
      const evidence = await store.aggregateAtomEvidence(WS, captured.atom.id);
      expect(evidence.delivered).toBeGreaterThanOrEqual(1);
      expect(evidence.attributed).toBe(1);

      // 5. Currency: a rewrite that drops the evidence silences the atom at the next index build.
      await store.updateMemory({ id: memory.id, content: "API bodies are now validated by the gateway; no client-side workaround is needed." });
      await syncHookIndex({ backend: store as never, workspaceId: WS, workspaceRoot: repo, env, refreshEpisodes: false });
      const after = JSON.parse(readFileSync(join(cache, "hook-index.json"), "utf8")) as { path_advisories?: Record<string, Array<{ ref: string }>> };
      expect(JSON.stringify(after.path_advisories ?? {})).not.toContain(captured.atom.id);
    } finally {
      store.close();
    }
  });
});
