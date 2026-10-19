// SPDX-License-Identifier: Apache-2.0
// An open knowledge gap reaches the agent WRITING inside it, once per session,
// through the real hook script. A session that never writes inside a gap pays zero bytes.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWLEDGE_GAP_HEADER, gapScopeOverlaps, renderGapBlock, selectGapsForScope, selectKnowledgeGap } from "@pathrule/core/knowledge-map/gap-delivery.js";
import type { KnowledgeGapStub } from "@pathrule/protocol/hook-index.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WITH_GAPS = "ws-gap-on";
const WITHOUT_GAPS = "ws-gap-off";
const STUB: KnowledgeGapStub = {
  ref: "gap_0a1b2c3d",
  scope: "packages/cli/src",
  line: "nothing recorded references packages/cli/src (14 commits in 60 days). If this task teaches you something durable here, record it with pathrule_record_learning and cite the files you read.",
};

let home: string;
let hookScript: string;
const roots: Record<string, string> = {};

async function workspace(id: string, extra: Record<string, unknown>): Promise<void> {
  const root = join(home, id);
  roots[id] = root;
  await mkdir(join(root, "packages", "cli", "src"), { recursive: true });
  const cacheDir = join(home, "cache", id);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: id,
      workspace_root: root,
      generated_at: "2026-10-01T00:00:00.000Z",
      session_digest: "",
      path_memories: {},
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      ...extra,
    }),
  );
  await writeFile(join(cacheDir, "warehouse.json"), "{}");
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "pathrule-hook-gap-"));
  hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await workspace(WITH_GAPS, { knowledge_gaps: [STUB] });
  await workspace(WITHOUT_GAPS, {});
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function runHook(id: string, session: string, tool: "Edit" | "Read", relPath: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PATHRULE_")));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hookScript], { env: { ...env, PATHRULE_HOME: home }, timeout: 15_000 }, (error, stdout) => {
      if (error && typeof error.code === "number" && error.code !== 0) reject(new Error(`hook exited ${error.code}: ${stdout}`));
      else resolve(stdout.trim());
    });
    child.stdin?.end(
      JSON.stringify({
        session_id: session,
        cwd: roots[id],
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input:
          tool === "Edit"
            ? { file_path: join(roots[id]!, relPath), old_string: "a", new_string: "b" }
            : { file_path: join(roots[id]!, relPath) },
      }),
    );
  });
}

const contextOf = (stdout: string): string => {
  try {
    return (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
  } catch {
    return "";
  }
};

describe("knowledge gap delivery in the hook", () => {
  it("tells the first write inside the gap, once per session", async () => {
    const first = contextOf(await runHook(WITH_GAPS, "s1", "Edit", "packages/cli/src/index.ts"));
    expect(first).toContain(KNOWLEDGE_GAP_HEADER);
    expect(first).toContain(STUB.line);
    const second = contextOf(await runHook(WITH_GAPS, "s1", "Edit", "packages/cli/src/other.ts"));
    expect(second).not.toContain(KNOWLEDGE_GAP_HEADER);
  });

  it("never tells a read, and never a write outside the gap", async () => {
    expect(contextOf(await runHook(WITH_GAPS, "s2", "Read", "packages/cli/src/index.ts"))).not.toContain(KNOWLEDGE_GAP_HEADER);
    expect(contextOf(await runHook(WITH_GAPS, "s3", "Edit", "packages/cli/README.md"))).not.toContain(KNOWLEDGE_GAP_HEADER);
  });

  it("costs nothing outside a gap: output is byte-identical to an index without gaps", async () => {
    const on = await runHook(WITH_GAPS, "s4", "Edit", "packages/cli/README.md");
    const off = await runHook(WITHOUT_GAPS, "s4", "Edit", "packages/cli/README.md");
    expect(on).toBe(off);
  });

  it("selects exactly what the TypeScript twin selects", () => {
    const index = { knowledge_gaps: [STUB] };
    expect(selectKnowledgeGap(index, "/packages/cli/src/index.ts", new Set())).toEqual(STUB);
    expect(selectKnowledgeGap(index, "packages/cli/srcx/index.ts", new Set())).toBeNull();
    expect(selectKnowledgeGap(index, "packages/cli/src/index.ts", new Set([STUB.ref]))).toBeNull();
  });

  it("names a gap to a turn only where the scopes overlap, two at most", () => {
    expect(gapScopeOverlaps("packages/cli/src", "/packages/cli/")).toBe(true);
    expect(gapScopeOverlaps("packages/cli/src", "packages/cli/src/commands")).toBe(true);
    expect(gapScopeOverlaps("packages/cli/src", "packages/cli/srcx")).toBe(false);
    expect(gapScopeOverlaps("packages/cli/src", "/")).toBe(false);
    const stubs = ["a", "b", "c"].map((name) => ({ ...STUB, ref: `gap_${name}`, scope: `packages/cli/${name}` }));
    expect(selectGapsForScope(stubs, "/packages/cli", new Set(["gap_a"])).map((stub) => stub.ref)).toEqual(["gap_b", "gap_c"]);
    expect(renderGapBlock([])).toBe("");
    expect(renderGapBlock([STUB])).toBe(`${KNOWLEDGE_GAP_HEADER}\n- ${STUB.line}`);
  });
});
