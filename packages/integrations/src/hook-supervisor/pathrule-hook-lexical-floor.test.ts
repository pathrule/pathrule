// SPDX-License-Identifier: Apache-2.0
// The keyword-overlap relevance gate (2026-08-23) — production-shaped black box.
//
// Before this gate `lexicalRankMemories` SORTED without DROPPING: a memory sharing
// not one token with the prompt still came back, just last, so top-k took it and
// the only bound on injected volume was the 12.000-char budget. Measured: 60
// prompts accumulated ~157K tokens and stopped when the knowledge base ran out,
// not when relevance did.
//
// The gate is CALIBRATED, and these tests exist to pin the calibration rather than
// the gate. `tokenize` matches exact tokens with no stemming, so Turkish inflection
// never meets its stem ("kuralları" vs "kural") — the same reason this workspace's
// router measurement showed 6 of 10 TR/EN pairs diverging. A hard floor would drop
// relevant memories every time morphology defeated the tokenizer. So the rule is:
// drop zero-overlap candidates ONLY when some other candidate overlapped. Any
// overlap is the evidence that tokenization worked for this prompt; none means the
// signal failed, and the gate must stand down rather than make the hook go blind.
//
// This is the LOCAL/OSS edition's ranking path: no network, no key, keyword overlap
// only. It is also the fallback under every richer path.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "55555555-5555-5555-5555-555555555555";

// Distinct previews on purpose: a shared preview would make every candidate
// overlap every prompt and the gate would have nothing to act on.
const MEMS = [
  { id: "f-auth", preview: "about authentication tokens" },
  { id: "f-db", preview: "about database schema" },
  { id: "f-ui", preview: "about button styling" },
];
const bodyOf = (id: string) => `BODY_${id}_floormarker`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-floor-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  // Exit 3 = no channel wired. This is the local/OSS edition's normal state, not an
  // error: no embedding key, no cloud session, keyword overlap only.
  const stub = join(home, "bin", "stub-nokey.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
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
      path_memories: {
        "/lib": MEMS.map((m) => ({
          id: m.id,
          title: `Memory ${m.id}`,
          preview: m.preview,
          node_path: "/lib",
          content_hash: `h-${m.id}`,
        })),
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      // No cloud_semantic block: this index was written by a local backend.
    }),
  );

  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        MEMS.map((m) => [
          m.id,
          { type: "memory", title: `Memory ${m.id}`, body: bodyOf(m.id), content_hash: `h-${m.id}` },
        ]),
      ),
    ),
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
          PATHRULE_EMBEDDING_PROVIDER: "",
          PATHRULE_EMBEDDING_API_KEY: "",
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

describe("keyword-overlap relevance gate (local edition)", () => {
  it("drops the candidates that share no token with the prompt", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const out = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "authentication tokens are rotating",
      "s-floor",
    );

    expect(out).toContain(bodyOf("f-auth"));
    // These two overlap nothing in this prompt. Before the gate they were still
    // eligible and top-k took them, which is how injected volume ended up bounded
    // by the char budget instead of by relevance.
    expect(out).not.toContain(bodyOf("f-db"));
    expect(out).not.toContain(bodyOf("f-ui"));
  });

  it("stands down when NO candidate overlaps, instead of injecting nothing", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    // Turkish inflection: the stems are in the corpus but `tokenize` has no stemmer,
    // so not one token meets. Treating that as "nothing is relevant" would make the
    // hook silent exactly for the prompts this owner actually writes.
    const out = await runPrompt(
      home,
      hookScript,
      wsRoot,
      stub,
      "kuralları düzeltelim ve yetkilendirmeye bakalım",
      "s-nosignal",
    );

    for (const m of MEMS) expect(out).toContain(bodyOf(m.id));
  });

  it("leaves no route history without the cloud extension, which records it", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    await runPrompt(home, hookScript, wsRoot, stub, "database schema migration", "s-log-open");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(home, "cache", "navigation"))).toBe(false);
  });
});
