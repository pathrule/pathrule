// SPDX-License-Identifier: Apache-2.0
// Production-shaped black-box: the offline UserPromptSubmit hook ranks a
// routed path's MANY memories against the prompt embedding and injects only the
// top-k relevant BODIES (not all of them, not the first-N by path order), with
// an intra-path topic-delta (same path, new topic → a new top-k) and a stub
// embedder (no live network). Mirrors the slim Claude render: the file holds
// only titles (indexed_memory_ids); the hook is the body channel.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "33333333-3333-3333-3333-333333333333";

// Six /lib memories on three topics; bodies tagged so we can assert which landed.
const MEMS = [
  { id: "m-auth1", topic: "auth", vec: [1, 0, 0.05] },
  { id: "m-auth2", topic: "auth", vec: [0.98, 0.02, 0] },
  { id: "m-db1", topic: "db", vec: [0, 1, 0] },
  { id: "m-db2", topic: "db", vec: [0.02, 0.97, 0] },
  { id: "m-ui1", topic: "ui", vec: [0, 0, 1] },
  { id: "m-ui2", topic: "ui", vec: [0.05, 0, 0.98] },
];
const bodyOf = (id: string) => `BODY_${id}_uniquemarker about ${MEMS.find((m) => m.id === id)!.topic}`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome(): Promise<{ home: string; hookScript: string; wsRoot: string; stub: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-topk-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  // Deterministic stub embedder: maps the prompt to a topic axis (no network).
  const stub = join(home, "bin", "stub-embed.cjs");
  await writeFile(
    stub,
    `const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{
      const p=Buffer.concat(c).toString("utf8").toLowerCase();
      let v=[0,0,0];
      if(/auth|login|key/.test(p))v=[1,0,0];
      else if(/database|schema|query|\\bdb\\b/.test(p))v=[0,1,0];
      else if(/\\bui\\b|button|style/.test(p))v=[0,0,1];
      process.stdout.write(JSON.stringify({embedding:v,dims:3,model:"stub"}));
      process.exit(0);
    });`,
  );

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-06-12T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
      // Slim render: titles are in the file, bodies are NOT → hook delivers top-k.
      indexed_memory_ids: MEMS.map((m) => m.id),
      path_memories: {
        "/lib": MEMS.map((m) => ({
          id: m.id,
          title: `Memory ${m.id}`,
          preview: `about ${m.topic}`,
          node_path: "/lib",
          content_hash: `h-${m.id}`,
        })),
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      // One auth-topic skill, title-indexed on /lib (slim) → eligible for top-k.
      path_skills: {
        "/lib": [
          { id: "s-auth", name: "auth-login-checklist", node_path: "/lib", preview: "auth login steps", content_hash: "h-s-auth" },
        ],
      },
      work_episode_index: [
        { paths: ["/lib"], subjects: ["lib", "auth", "database", "ui"], summary: "lib work" },
      ],
    }),
  );

  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify({
      ...Object.fromEntries(
        MEMS.map((m) => [
          m.id,
          { type: "memory", title: `Memory ${m.id}`, body: bodyOf(m.id), content_hash: `h-${m.id}` },
        ]),
      ),
      "s-auth": {
        type: "skill",
        title: "auth-login-checklist",
        body: "BODY_s-auth_uniquemarker auth login checklist steps",
        content_hash: "h-s-auth",
      },
    }),
  );
  await writeFile(
    join(cacheDir, "embeddings.json"),
    JSON.stringify({ ...Object.fromEntries(MEMS.map((m) => [m.id, m.vec])), "s-auth": [1, 0, 0.05] }),
  );

  return { home, hookScript, wsRoot, stub };
}

function runPrompt(
  home: string,
  hookScript: string,
  wsRoot: string,
  stub: string,
  prompt: string,
  sessionId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
          PATHRULE_NAVIGATION: "on",
          PATHRULE_EMBED_HELPER: stub,
        },
        timeout: 10_000,
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
      JSON.stringify({ cwd: wsRoot, prompt, session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    );
  });
}

describe("Voyage top-k body injection (production-shaped, stub embedder)", () => {
  it("injects only the prompt-relevant top-k bodies, not all 6", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const ctx = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "In the lib auth area, which login key must I avoid?",
      "sess-1",
    );
    // auth memories delivered; db/ui memories NOT (below the cosine threshold).
    expect(ctx).toContain(bodyOf("m-auth1"));
    expect(ctx).toContain(bodyOf("m-auth2"));
    expect(ctx).not.toContain(bodyOf("m-db1"));
    expect(ctx).not.toContain(bodyOf("m-ui1"));
  });

  // POLICY CHANGE, 2026-08-23. This test used to assert the opposite — that a relevant
  // skill's BODY is delivered pooled with memories. It is inverted deliberately, not
  // weakened to make a build pass.
  //
  // Why: a memory is a fact and a rule is a constraint, but a skill body is a PROCEDURE.
  // Delivering one unasked does not inform the agent, it instructs it, and an instruction
  // that arrived because a title shared a token with the prompt is how an agent starts
  // following a release checklist in the middle of a bug fix. Measured across this
  // workspace's 47 skills: average body 4.974 chars, largest 51.013 (~12.753 tokens,
  // four times the whole body budget), 27 of 47 larger than the average memory.
  //
  // So a skill is offered by NAME, hedged, and the agent decides. The only route to a
  // full skill body is the explicit `::skill-name` gate the protocol already defines.
  it("offers a relevant skill by NAME and never delivers its body", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const ctx = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "In the lib auth area, which login key must I avoid?",
      "sess-skill",
    );
    expect(ctx).not.toContain("BODY_s-auth_uniquemarker"); // no procedure injected
    expect(ctx).toContain("auth-login-checklist"); // but the agent knows it exists
    expect(ctx).toContain("MIGHT apply"); // hedged, never "use this skill"
    expect(ctx).toContain("pathrule_read_skill(id)"); // and can fetch it itself
    expect(ctx).not.toContain(bodyOf("m-db1")); // db memory still excluded
  });

  it("re-selects a NEW top-k on an intra-path topic change (same /lib route)", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const first = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "In the lib auth area, which login key must I avoid?",
      "sess-2",
    );
    expect(first).toContain(bodyOf("m-auth1"));

    // Same path (/lib), different topic → the body block re-selects.
    const second = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "In the lib database area, what schema query do we use?",
      "sess-2",
    );
    expect(second).toContain(bodyOf("m-db1"));
    expect(second).not.toContain(bodyOf("m-auth1")); // not re-delivered (delta) + different topic
  });

  it("stays silent on an identical repeat (cache-stable)", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const p = "In the lib auth area, which login key must I avoid?";
    const first = await runPrompt(home, hookScript, wsRoot, stub, p, "sess-3");
    expect(first).toContain(bodyOf("m-auth1"));
    const second = await runPrompt(home, hookScript, wsRoot, stub, p, "sess-3");
    expect(second).not.toContain(bodyOf("m-auth1")); // unchanged intent → silent
  });
});
