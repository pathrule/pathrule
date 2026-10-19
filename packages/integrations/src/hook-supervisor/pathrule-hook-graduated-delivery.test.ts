// SPDX-License-Identifier: Apache-2.0
// Graduated delivery (2026-08-23): relevance decides the FORM, not only the order.
//
// Every ranked memory used to ship whole. Measured on 8 real prompts, the scores behind
// those bodies looked like [0.288, 0.267, 0.182, 0.114, 0.111, 0.106, 0.067, 0.059] and
// all eight got identical treatment, while 1-8 further items were dropped for want of
// space. So the block spent ~1.400 chars on the eighth-best match and nothing on the
// ninth.
//
// Now the head keeps its body and the tail is offered as name + id + one line. Nothing
// becomes unreachable — it becomes cheaper to offer — and the demotion is what finally
// makes relevance OBSERVABLE: a name that gets pulled is a label, and a pushed body
// never produced one.
//
// The measured trade behind the default of 3 bodies:
//
//   K=2  top-1 body 7/8  top-2 7/8  top-3 0/8   17.643 tokens
//   K=3  top-1 body 7/8  top-2 7/8  top-3 7/8   20.375 tokens
//   K=8  top-1 body 7/8  top-2 7/8  top-3 7/8   22.462 tokens
//   shipped baseline                            20.587 tokens
//
// K=2 buys 13% by giving up the third-best body on every prompt. K=3 keeps the top three
// and still lands under the baseline, so correctness sets the default and the cheaper
// setting stays available through PATHRULE_BODY_COUNT_MAX.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "88888888-8888-8888-8888-888888888888";

// Graded on purpose: the number of prompt tokens each preview shares decides its rank,
// so the expected body/name split is computable rather than guessed.
const MEMS = [
  { id: "g-1", preview: "caching invalidation strategy layered ttl", share: 4 },
  { id: "g-2", preview: "caching invalidation strategy", share: 3 },
  { id: "g-3", preview: "caching invalidation", share: 2 },
  { id: "g-4", preview: "caching", share: 1 },
  { id: "g-5", preview: "caching", share: 1 },
];
const PROMPT = "caching invalidation strategy layered ttl";
const bodyOf = (id: string) => `GBODY_${id}_marker`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-grad-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  // Exit 3: keyword-overlap path, which is where the graded scores come from.
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
        "/": MEMS.map((m) => ({
          id: m.id,
          title: `Memory ${m.id}`,
          preview: m.preview,
          node_path: "/",
          content_hash: `h-${m.id}`,
        })),
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
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
            // Bodies are long enough that promoting or demoting one is visible in the size.
            body: `${bodyOf(m.id)} ${m.preview} ${"filler ".repeat(120)}`,
            content_hash: `h-${m.id}`,
          },
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
  sessionId: string,
  bodyCountMax?: number,
  defaults = false,
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
          // The graduation mechanism, measured at the earlier wide settings; the defaults are pinned below.
          ...(defaults ? {} : { PATHRULE_PROMPT_BODY_BUDGET_CHARS: "12000", PATHRULE_INJECT_TOPK: "8" }),
          PATHRULE_EMBED_HELPER: stub,
          PATHRULE_EMBEDDING_PROVIDER: "",
          PATHRULE_EMBEDDING_API_KEY: "",
          ...(bodyCountMax === undefined
            ? {}
            : { PATHRULE_BODY_COUNT_MAX: String(bodyCountMax) }),
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
      JSON.stringify({ cwd: wsRoot, prompt: PROMPT, session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    );
  });
}

const bodyCount = (out: string) => (out.match(/\nGBODY_/g) ?? []).length;

describe("graduated body delivery", () => {
  it("gives bodies to the top matches and names to the tail", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const out = await runPrompt(home, hookScript, wsRoot, stub, "g-default");

    // Default is 3 bodies. The two best-scoring previews must be among them.
    expect(out).toContain(bodyOf("g-1"));
    expect(out).toContain(bodyOf("g-2"));
    expect(bodyCount(out)).toBeLessThanOrEqual(3);
    // And the demotions are OFFERED, not discarded.
    expect(out).toContain("names only");
    expect(out).toMatch(/- Memory g-[45] \(id: g-[45]\)/);
  });

  it("keeps every demoted item reachable by id", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const out = await runPrompt(home, hookScript, wsRoot, stub, "g-reach", 1);

    // One body only: four items are demoted, and all four must still be addressable.
    // A name without an id is a dead end, which is what the old "(N more item(s))" line was.
    expect(bodyCount(out)).toBe(1);
    const named = MEMS.filter((m) => !out.includes(bodyOf(m.id)));
    expect(named.length).toBe(4);
    for (const m of named) expect(out).toContain(`(id: ${m.id})`);
  });

  it("costs less the fewer bodies it sends, and never silently loses an item", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const wide = await runPrompt(home, hookScript, wsRoot, stub, "g-wide", 5);
    const narrow = await runPrompt(home, hookScript, wsRoot, stub, "g-narrow", 1);

    expect(narrow.length).toBeLessThan(wide.length);
    // Same five items are accounted for either way — the difference is form, not coverage.
    for (const m of MEMS) {
      expect(wide, `${m.id} in wide`).toContain(m.id);
      expect(narrow, `${m.id} in narrow`).toContain(m.id);
    }
  });

  // The count cap holds even when relevance is unknown, and that is the point: a prompt
  // the scorer cannot read is the WORST case to spend eight bodies on — maximum cost,
  // zero confidence. Bounded cost with a named remainder beats a full push chosen by the
  // tie-break, which is UUID order.
  it("keeps cost bounded even when no ranking produced a score", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    // A prompt sharing no token with any preview: the scorer stands down (see the
    // calibrated keyword gate), so there is no basis for demoting anything. Demoting on
    // absent evidence would silently withhold knowledge.
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [hookScript],
        {
          env: {
            ...process.env,
            PATHRULE_HOME: home,
            PATHRULE_HOOK_EVENT: "UserPromptSubmit",
            PATHRULE_NAVIGATION: "on",
          // The graduation mechanism, measured at the earlier wide settings; the defaults are pinned below.
          PATHRULE_PROMPT_BODY_BUDGET_CHARS: "12000",
          PATHRULE_INJECT_TOPK: "8",
            PATHRULE_EMBED_HELPER: stub,
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
          prompt: "kuralları düzeltelim ve yetkilendirmeye bakalım",
          session_id: "g-nosignal",
          hook_event_name: "UserPromptSubmit",
        }),
      );
    });

    expect(bodyCount(out)).toBeLessThanOrEqual(3);
    // Nothing is dropped for lack of a score — the remainder is offered by name.
    for (const m of MEMS) expect(out).toContain(m.id);
  });

  // Every injected char is re-read on every later model call (fastapi, 2026-10-15: ~30k chars a session
  // at the wide settings), so the default ships the best body and offers the next three by name.
  it("by default ships one body, offers the rest by name, and stays small", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome();
    const out = await runPrompt(home, hookScript, wsRoot, stub, "g-defaults", undefined, true);
    expect(out).toContain(bodyOf("g-1"));
    expect(bodyCount(out)).toBeLessThanOrEqual(2);
    expect(out).toMatch(/\(id: g-[2-4]\)/);
  });
});
