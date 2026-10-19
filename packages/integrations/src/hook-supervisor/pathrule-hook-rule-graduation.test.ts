// SPDX-License-Identifier: Apache-2.0
// Rules under graduated delivery (2026-08-23).
//
// Rules used to bypass relevance entirely: selected by path and priority, delivered whole,
// unconditionally. Measured on the first prompt of a session asking about `supabase
// migration grants`: 10.476 chars went out, 100% rule bodies, ZERO memories, and among them
// "No em dashes anywhere in the project" and "Keep pull requests small and single-purpose".
// Three memories had ranked and all three were dropped for want of space.
//
// Priority cannot fix this — 50 of this workspace's 61 rules are `high`, so it separates
// nothing. Relevance can: the rule this prompt is about keeps its body, and the rest arrive
// as a name plus an id.
//
// The line this must not cross: a rule may lose its BODY but never its VISIBILITY. A
// standing constraint the agent cannot see is worse than one it has to read.
//
// The default of one body was chosen by sweep, not taste (9 prompts, ground-truth ranking):
//
//   cap  token   mem top-3  mem reachable
//    1   24.285      14           62
//    3   26.473      13           48
//   12   26.513      12           43
//
// One body wins on every axis at once, and the rule metrics do not move — because the cap
// changes the FORM of the rules below the top one, not whether they are delivered.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROMPT = "caching invalidation revalidate stale edge";

// One rule squarely on the prompt, two with nothing to do with it, one strict.
const RULES = [
  { id: "r-topic", name: "Caching invalidation must revalidate stale edge entries", strict: false, on: true },
  { id: "r-dash", name: "No em dashes anywhere in the project", strict: false, on: false },
  { id: "r-pr", name: "Keep pull requests small and single-purpose", strict: false, on: false },
];
const STRICT = { id: "r-strict", name: "Never commit a secret", strict: true, on: false };
const rbody = (id: string) => `RBODY_${id}_marker`;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome(withStrict: boolean) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-rulegrad-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  const all = withStrict ? [...RULES, STRICT] : RULES;

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
        "/": all.map((r) => ({
          id: r.id,
          name: r.name,
          preview: r.on ? "caching invalidation revalidate stale edge" : "unrelated preview text",
          node_path: "/",
          priority: "high",
          enforcement: r.strict ? "strict" : "advisory",
          content_hash: `h-${r.id}`,
        })),
      },
      project_rules: [],
      recent_subjects: [],
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        all.map((r) => [
          r.id,
          {
            type: "rule",
            title: r.name,
            body: `${rbody(r.id)} ${r.on ? "caching invalidation revalidate stale edge" : "zzqq"} ${"filler ".repeat(90)}`,
            content_hash: `h-${r.id}`,
          },
        ]),
      ),
    ),
  );
  return { home, hookScript, wsRoot, stub };
}

/** Three rules that all match the prompt, so the CAP is the binding constraint. */
async function makeHomeMultiRelevant() {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-rulegrad-multi-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);
  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });
  const multi = [
    { id: "m-1", name: "Caching invalidation revalidate stale edge one" },
    { id: "m-2", name: "Caching invalidation revalidate stale edge two" },
    { id: "m-3", name: "Caching invalidation revalidate stale edge three" },
  ];
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
        "/": multi.map((r) => ({
          id: r.id,
          name: r.name,
          preview: "caching invalidation revalidate stale edge",
          node_path: "/",
          priority: "high",
          enforcement: "advisory",
          content_hash: `h-${r.id}`,
        })),
      },
      project_rules: [],
      recent_subjects: [],
    }),
  );
  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        multi.map((r) => [
          r.id,
          {
            type: "rule",
            title: r.name,
            body: `${rbody(r.id)} caching invalidation revalidate stale edge ${"filler ".repeat(60)}`,
            content_hash: `h-${r.id}`,
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
  ruleCap?: number,
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
          ...(ruleCap === undefined ? {} : { PATHRULE_RULE_BODY_COUNT_MAX: String(ruleCap) }),
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

describe("rule graduation", () => {
  it("gives the body to the rule this prompt is about", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(false);
    const out = await runPrompt(home, hookScript, wsRoot, stub, "rg-topic");
    expect(out).toContain(rbody("r-topic"));
  });

  it("sends an unrelated rule as a name, not a body", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(false);
    const out = await runPrompt(home, hookScript, wsRoot, stub, "rg-name");

    // The owner's own example: an em-dash ban has nothing to do with a caching prompt, and
    // naming it is enough for the agent to notice the constraint exists.
    expect(out).not.toContain(rbody("r-dash"));
    expect(out).not.toContain(rbody("r-pr"));
    expect(out).toContain("No em dashes anywhere in the project");
    expect(out).toContain("Keep pull requests small and single-purpose");
  });

  it("never lets a rule lose its visibility or its id", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(false);
    const out = await runPrompt(home, hookScript, wsRoot, stub, "rg-vis");

    // Losing a body is a cost decision; losing the id makes the rule unfetchable, which
    // would turn a demotion into a deletion.
    for (const r of RULES) expect(out, r.id).toMatch(new RegExp(`${r.id}`));
    expect(out).toMatch(/Rules in scope, names only/);
    // And the wording has to say the demoted ones still bind.
    expect(out).toMatch(/BIND even where the body is not shown/);
  });

  // Caught by measurement, not review. Graduated delivery cut a session by 13,9%, then by
  // only 3,6% once rules joined it — because a demoted item's content hash is never
  // recorded (only DELIVERED items record theirs), so every prompt re-announced the same
  // names. Announcing once restored it to 10,7%.
  it("announces a name once per session, not on every prompt", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(false);
    const first = await runPrompt(home, hookScript, wsRoot, stub, "rg-once");
    expect(first).toContain("No em dashes anywhere in the project");

    const second = await runPrompt(home, hookScript, wsRoot, stub, "rg-once");
    // Said once. A rule that later becomes relevant still earns its BODY — that delivery
    // adds something, a repeated name does not.
    expect(second).not.toContain("No em dashes anywhere in the project");
  });

  it("keeps a STRICT rule's body regardless of relevance or cap", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(true);
    // Cap of one, and the strict rule is the least relevant thing in the fixture.
    const out = await runPrompt(home, hookScript, wsRoot, stub, "rg-strict", 1);

    // A strict rule blocks a tool call. A name cannot explain a block, so it is exempt.
    expect(out).toContain(rbody("r-strict"));
    expect(out).toContain(rbody("r-topic"));
  });

  // The cap only binds when several rules are RELEVANT. With one relevant rule the
  // relative bar is what limits delivery, and raising the cap changes nothing — which is
  // the intended order of authority: relevance first, cost ceiling second. The first draft
  // of this test asserted the opposite and was wrong, not the code.
  it("lets the cap bind only when several rules are relevant", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHomeMultiRelevant();
    const one = await runPrompt(home, hookScript, wsRoot, stub, "rg-c1", 1);
    const three = await runPrompt(home, hookScript, wsRoot, stub, "rg-c3", 3);

    const count = (s: string) => (s.match(/RBODY_/g) ?? []).length;
    expect(count(one)).toBe(1);
    expect(count(three)).toBeGreaterThan(1);
    expect(one.length).toBeLessThan(three.length);
  });

  it("does not raise delivery above the bar just because the cap allows it", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome(false);
    // One relevant rule, two irrelevant. A cap of 3 must not promote the irrelevant ones:
    // the bar decides WHETHER, the cap only decides HOW MANY of those that qualify.
    const out = await runPrompt(home, hookScript, wsRoot, stub, "rg-bar", 3);
    expect((out.match(/RBODY_/g) ?? []).length).toBe(1);
    expect(out).toContain(rbody("r-topic"));
  });
});
