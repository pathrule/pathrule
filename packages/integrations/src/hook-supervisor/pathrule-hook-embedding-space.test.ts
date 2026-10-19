// SPDX-License-Identifier: Apache-2.0
// Production-shaped black box: the UserPromptSubmit hook compares a prompt vector with the vectors
// in embeddings.json only when both are in one space, the one hook-index.json names. Any other
// pairing (a provider or model switch, an index that names no space) ranks by keywords and says so
// (`fallback_space_mismatch`), because two models' vectors of one dimension are unrelated. A model
// with its own cosine floor brings it in the helper's output, and an explicit
// PATHRULE_INJECT_MIN_SIMILARITY still wins.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "55555555-5555-5555-5555-555555555555";
const SPACE = "local/qwen3-embedding:0.6b@3#v1";

const MEMS = [
  { id: "m-auth", topic: "auth", vec: [1, 0, 0] },
  { id: "m-db", topic: "db", vec: [0, 1, 0] },
  // cosine 0.35 with an auth prompt: between a 0.30 model floor and the 0.40 default.
  { id: "m-near", topic: "tokens", vec: [0.35, 0, 0.9367] },
];
const bodyOf = (id: string) => `BODY_${id}_spacemarker`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome(opts: {
  indexSpace: string | null;
  helperOutput: Record<string, unknown>;
}) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-space-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  // The helper's contract: the prompt on stdin, one JSON object on stdout.
  const stub = join(home, "bin", "stub-embed.cjs");
  await writeFile(
    stub,
    `const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{
      process.stdout.write(${JSON.stringify(JSON.stringify(opts.helperOutput))});
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
      generated_at: "2026-10-12T00:00:00.000Z",
      session_digest: "",
      knowledge_compiled: true,
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
      work_episode_index: [{ paths: ["/lib"], subjects: ["lib", "auth"], summary: "lib work" }],
      ...(opts.indexSpace ? { embedding_space: opts.indexSpace } : {}),
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        MEMS.map((m) => [
          m.id,
          {
            type: "memory",
            title: `Memory ${m.id}`,
            body: bodyOf(m.id),
            content_hash: `h-${m.id}`,
          },
        ]),
      ),
    ),
  );
  await writeFile(
    join(cacheDir, "embeddings.json"),
    JSON.stringify(Object.fromEntries(MEMS.map((m) => [m.id, m.vec]))),
  );
  return { home, hookScript, wsRoot, stub };
}

function runPrompt(
  setup: { home: string; hookScript: string; wsRoot: string; stub: string },
  prompt: string,
  extraEnv: Record<string, string> = {},
): Promise<{ context: string; select: string | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [setup.hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: setup.home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
          PATHRULE_NAVIGATION: "on",
          PATHRULE_EMBED_HELPER: setup.stub,
          PATHRULE_BODY_PROBE: "1",
          PATHRULE_INJECT_MIN_SIMILARITY: "",
          ...extraEnv,
        },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        const probe = /PATHRULE_BODY_PROBE (.*)/.exec(stderr);
        let context = stdout.trim();
        try {
          context = JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "";
        } catch {
          /* plain output */
        }
        resolve({ context, select: probe ? (JSON.parse(probe[1]!).select as string) : null });
      },
    );
    child.stdin!.end(
      JSON.stringify({
        cwd: setup.wsRoot,
        prompt,
        session_id: `s-${Math.random()}`,
        hook_event_name: "UserPromptSubmit",
      }),
    );
  });
}

const PROMPT = "In the lib auth area, which login key must I avoid?";
const vector = { embedding: [1, 0, 0], dims: 3, model: "qwen3-embedding:0.6b" };

describe("hook vector spaces", () => {
  it("ranks by cosine when the prompt vector is in the index's space", async () => {
    const setup = await makeHome({ indexSpace: SPACE, helperOutput: { ...vector, space: SPACE } });
    const { context, select } = await runPrompt(setup, PROMPT);
    expect(select).toBe("hit");
    expect(context).toContain(bodyOf("m-auth"));
    expect(context).not.toContain(bodyOf("m-db"));
  });

  it("falls back to keywords when the spaces differ, even at one dimension", async () => {
    const setup = await makeHome({
      indexSpace: "cloudflare/@cf/qwen/qwen3-embedding-0.6b@3#v1",
      helperOutput: { ...vector, space: SPACE },
    });
    expect((await runPrompt(setup, PROMPT)).select).toBe("fallback_space_mismatch");
  });

  it("falls back to keywords when the index names no space for a prompt vector that has one", async () => {
    const setup = await makeHome({ indexSpace: null, helperOutput: { ...vector, space: SPACE } });
    expect((await runPrompt(setup, PROMPT)).select).toBe("fallback_space_mismatch");
  });

  it("uses the model's own floor, unless the environment sets one", async () => {
    const setup = await makeHome({
      indexSpace: SPACE,
      helperOutput: { ...vector, space: SPACE, min_similarity: 0.3 },
    });
    // Ranked (graduated delivery may offer it by name rather than body): it passed the floor.
    const withFloor = await runPrompt(setup, PROMPT);
    expect(withFloor.select).toBe("hit");
    expect(withFloor.context).toContain(bodyOf("m-auth"));
    expect(withFloor.context).toContain("Memory m-near");

    const overridden = await runPrompt(setup, PROMPT, { PATHRULE_INJECT_MIN_SIMILARITY: "0.4" });
    expect(overridden.select).toBe("hit");
    expect(overridden.context).toContain(bodyOf("m-auth"));
    expect(overridden.context).not.toContain("Memory m-near");

    // Without a model floor the default 0.40 applies.
    const plain = await makeHome({ indexSpace: SPACE, helperOutput: { ...vector, space: SPACE } });
    expect((await runPrompt(plain, PROMPT)).context).not.toContain("Memory m-near");
  });
});
