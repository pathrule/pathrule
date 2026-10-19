// SPDX-License-Identifier: Apache-2.0
// PreToolUse as the NAME channel (2026-08-23).
//
// Three separate defects were measured in this handler and all three are pinned here.
//
// 1. It emitted NOTHING. `emitWorkStateDegradedPass()` wrote "{}" and exited whenever the
//    teammate-conflict probe missed its 80 ms cold-path budget — and that probe needs
//    ~303 ms, so 29 of 29 measured decisions came back `pass_work_conflict:degraded`.
//    The audit found 38 injections across 1.818 firings: 5 memories in 8 days. Not
//    knowing whether a teammate holds a file is no reason to withhold the knowledge
//    attached to it.
//
// 2. It carried FULL BODIES. One attached body lifts the cap from 1.500 to 12.000 chars,
//    and this handler runs on every Read/Edit/Write. Measured right after (1) was fixed:
//    12.000 chars on 5 of 5 files, and no convergence on repeat calls for the same file.
//    Roughly 3.000 tokens per tool call.
//
// 3. Path was matched as TEXT, not as a relation. Scores were computed over
//    `title + preview + node_path`, so a file path's own directory names vouched for
//    unrelated knowledge: editing a Kanban board file offered "Preserve the E2E
//    encryption contract" and "Studio native macOS menu", both attached above /studio,
//    both sharing exactly the token "studio".
//
// What the channel is for: at the moment a file is touched, name the constraints and
// memories that live on that path, with their ids, and let the agent pull the body of
// whichever it judges relevant — including one whose title has nothing to do with the
// prompt but is a standing constraint it must still obey.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "77777777-7777-7777-7777-777777777777";
const REL = "packages/app/src/studio/sidebar/Board.tsx";

// Chosen so each case differs by ONE thing: how the memory's node relates to the file,
// and how many tokens it shares with the file path.
const MEMS = [
  {
    id: "m-exact",
    node: "/packages/app/src/studio/sidebar/Board.tsx",
    title: "Board layout notes",
    // Same node, one shared token ("board") → 1 × 1.0 clears a threshold of 1.
    offered: true,
  },
  {
    id: "m-anc-weak",
    node: "/packages/app/src/studio",
    title: "Crypto contract stays byte identical",
    // Ancestor with ZERO shared tokens: nothing in the title or preview meets the file
    // path or the edit text, so it never clears the threshold. Kept as the exclusion case.
    //
    // NOTE, corrected 2026-08-23: an earlier version of this comment claimed the exclusion
    // came from the path tier (1 × 0.85 < 1). It did not — this case has no overlap at all,
    // so the tier was never what decided it. The tier now RANKS and does not GATE, because
    // gating on `score × tier` made a threshold of 1 unreachable from any ancestor and
    // dropped a genuine match ("Translation file workflow" on an i18n edit), which the
    // AI-contract suite caught.
    offered: false,
  },
  {
    id: "m-anc-strong",
    node: "/packages/app/src/studio",
    title: "Studio sidebar layout anatomy",
    // Ancestor, two shared tokens ("studio", "sidebar") → 2 × 0.85 = 1.7 clears 1.
    offered: true,
  },
];

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-name-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, dirname(REL)), { recursive: true });
  await writeFile(join(wsRoot, REL), "export const Board = () => null;\n");
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-08-23T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
      indexed_memory_ids: MEMS.map((m) => m.id),
      path_memories: MEMS.reduce<Record<string, unknown[]>>((acc, m) => {
        (acc[m.node] ||= []).push({
          id: m.id,
          title: m.title,
          preview: "preview text",
          node_path: m.node,
          content_hash: `h-${m.id}`,
        });
        return acc;
      }, {}),
      path_rules: {
        "/packages/app/src/studio/sidebar": [
          {
            id: "r-sidebar",
            name: "Sidebar rule",
            preview: "sidebar rule preview",
            node_path: "/packages/app/src/studio/sidebar",
            priority: "high",
            enforcement: "advisory",
            content_hash: "h-r-sidebar",
          },
        ],
      },
      project_rules: [],
      recent_subjects: [],
    }),
  );

  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify({
      "r-sidebar": {
        type: "rule",
        title: "Sidebar rule",
        body: "RULEBODY_r-sidebar full text",
        content_hash: "h-r-sidebar",
      },
      ...Object.fromEntries(
        MEMS.map((m) => [
          m.id,
          { type: "memory", title: m.title, body: `MEMBODY_${m.id} full text`, content_hash: `h-${m.id}` },
        ]),
      ),
    }),
  );

  return { home, hookScript, wsRoot };
}

function runEdit(home: string, hookScript: string, wsRoot: string, sessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "PreToolUse",
          PATHRULE_NAVIGATION: "on",
        },
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
        tool_input: { file_path: join(wsRoot, REL), old_string: "null", new_string: "undefined" },
        session_id: sessionId,
        hook_event_name: "PreToolUse",
      }),
    );
  });
}

describe("PreToolUse name channel", () => {
  it("delivers path knowledge even though no supervisor answers the conflict probe", async () => {
    // There is no hook-supervisor.json in this temp home, so the teammate-conflict
    // check cannot complete — the exact condition that used to emit "{}" and exit.
    const { home, hookScript, wsRoot } = await makeHome();
    const out = await runEdit(home, hookScript, wsRoot, "n-degraded");

    expect(out).not.toBe("");
    expect(out).toContain("Pathrule context for");
    expect(out).toContain("Sidebar rule");
  });

  it("offers names and ids, never bodies", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const out = await runEdit(home, hookScript, wsRoot, "n-names");

    // No body text from any item, and no "### " heading, which is the body render.
    expect(out).not.toContain("RULEBODY_");
    expect(out).not.toContain("MEMBODY_");
    expect(out).not.toContain("\n### ");
    // The ids and the pull route have to be there, or a name is a dead end.
    expect(out).toMatch(/\(id: [0-9a-z-]+\)/);
    expect(out).toContain("pathrule_read_memory(id)");
    // Bounded by MAX_CONTEXT_CHARS, not the 12.000 body ceiling.
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  // What this pins is that node_path is not matched as TEXT: a memory whose only connection
  // is that its node name appears in the file path does not qualify. The tier's ORDERING
  // role is exercised where a path relation exists and scores compete.
  it("does not let a node name in the file path vouch for unrelated knowledge", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const out = await runEdit(home, hookScript, wsRoot, "n-tier");

    for (const m of MEMS) {
      if (m.offered) expect(out, `${m.id} should be offered`).toContain(m.title);
      else expect(out, `${m.id} should NOT be offered`).not.toContain(m.title);
    }
  });

  // Found by a live smoke test on 2026-08-23, not by review: a real call that offered two
  // rule names and no memories printed the EDIT hint and no READ route, because
  // `hasPreviewOnly` only looked at memories while rules are always preview-only here. Two
  // names and no way to fetch either — the exact dead end this channel exists to avoid.
  it("tells the agent how to fetch a body even when only rules were named", async () => {
    const home = await mkdtemp(join(tmpdir(), "pathrule-hook-ruleonly-"));
    homes.push(home);
    const hookScript = join(home, "bin", "pathrule-hook.js");
    await mkdir(dirname(hookScript), { recursive: true });
    await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
    const wsRoot = join(home, "project");
    await mkdir(join(wsRoot, dirname(REL)), { recursive: true });
    await writeFile(join(wsRoot, REL), "export const Board = () => null;\n");
    const cacheDir = join(home, "cache", WS_ID);
    await mkdir(cacheDir, { recursive: true });
    // Rules only: no path_memories at all.
    await writeFile(
      join(cacheDir, "hook-index.json"),
      JSON.stringify({
        workspace_id: WS_ID,
        workspace_root: wsRoot,
        generated_at: "2026-08-23T00:00:00.000Z",
        session_digest: "",
        knowledge_compiled: true,
        path_memories: {},
        path_rules: {
          "/packages/app/src/studio/sidebar": [
            {
              id: "r-only",
              name: "Sidebar rule",
              preview: "sidebar rule preview",
              node_path: "/packages/app/src/studio/sidebar",
              priority: "high",
              enforcement: "advisory",
              content_hash: "h-r-only",
            },
          ],
        },
        project_rules: [],
        recent_subjects: [],
      }),
    );
    await writeFile(
      join(cacheDir, "warehouse.json"),
      JSON.stringify({
        "r-only": {
          type: "rule",
          title: "Sidebar rule",
          body: "RULEBODY_r-only",
          content_hash: "h-r-only",
        },
      }),
    );

    const out = await runEdit(home, hookScript, wsRoot, "n-ruleonly");
    expect(out).toContain("Sidebar rule");
    expect(out).toContain("(id: r-only)");
    expect(out).toContain("pathrule_read_rule(id)");
    expect(out).not.toContain("RULEBODY_");
  });

  it("goes quiet on repeat instead of draining the knowledge base", async () => {
    const { home, hookScript, wsRoot } = await makeHome();
    const first = await runEdit(home, hookScript, wsRoot, "n-repeat");
    const second = await runEdit(home, hookScript, wsRoot, "n-repeat");
    const third = await runEdit(home, hookScript, wsRoot, "n-repeat");

    expect(first.length).toBeGreaterThan(0);
    // Same file, same session: everything relevant was already named. Continuing to
    // emit here is what turned this channel into a per-tool-call tax.
    expect(second.length + third.length).toBe(0);
  });
});
