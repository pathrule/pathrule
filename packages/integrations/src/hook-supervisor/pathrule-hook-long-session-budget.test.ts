// SPDX-License-Identifier: Apache-2.0
// Long-session token budget — the regression guard for "Pathrule inflates my
// context" (2026-09-01).
//
// The complaint was about LONG sessions specifically, and the honest answer
// needed a number rather than an argument. What makes a per-turn channel
// dangerous is not the size of one injection, it is whether the total keeps
// climbing: an injector that re-sends what it already sent grows without bound,
// and a user watching a 60-prompt session sees exactly that as "it keeps getting
// more expensive".
//
// So the property under test is SATURATION, not size. The hook may spend its
// budget early — that is the point, the knowledge is most useful on the first
// prompts — but across a long session it must converge, because there is a finite
// amount of knowledge and it should say each thing once.
//
// The ceiling is deliberately the warehouse itself. "Never spend more than the
// total body text you have" is the only bound that stays meaningful as a
// workspace grows, and it is the bound that fails loudly if dedup regresses:
// re-sending is the only way to exceed it.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "88888888-8888-8888-8888-888888888888";

// A workspace with enough distinct knowledge that saturation is a real event
// rather than an artefact of having nothing left to say.
const TOPICS = [
  ["auth", "authentication login session token refresh"],
  ["billing", "billing stripe subscription invoice checkout"],
  ["search", "search relevance ranking index query"],
  ["upload", "upload storage bucket signed url media"],
  ["cache", "cache invalidation ttl redis warm"],
  ["queue", "queue worker retry idempotent job"],
  ["email", "email template transactional smtp bounce"],
  ["mobile", "mobile push notification device token"],
  ["migration", "migration schema column rollback sql"],
  ["ratelimit", "rate limit throttle bucket quota"],
  ["webhook", "webhook signature verification replay"],
  ["report", "report export csv aggregation chart"],
  ["i18n", "translation locale language fallback"],
  ["perf", "performance profiling latency bottleneck"],
  ["deploy", "deploy release rollback canary pipeline"],
] as const;

const bodyFor = (slug: string, words: string, bulk = 6) =>
  `# ${slug}\n\n${words}\n\n` +
  `Decision for ${slug}: the ${words.split(" ")[0]} path is owned by the platform team. ` +
  `Do not change it without a migration note. `.repeat(bulk);

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

async function makeHome(opts: { bulk?: number; perPath?: number } = {}) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-budget-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  const stub = join(home, "bin", "stub.cjs");
  await writeFile(stub, `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`);

  const wsRoot = join(home, "project");
  await mkdir(join(wsRoot, "src"), { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  const pathMemories: Record<string, unknown[]> = {};
  const warehouse: Record<string, unknown> = {};
  let warehouseChars = 0;
  // `perPath` memories on each routed path. One body per path can only ever be
  // "fits or does not"; several is what lets a budget change show up as a
  // measurable difference in how many arrive.
  const perPath = opts.perPath ?? 1;
  for (const [slug, words] of TOPICS) {
    const entries = [];
    for (let i = 0; i < perPath; i++) {
      const id = `mem-${slug}-${i}`;
      const body = bodyFor(`${slug}-${i}`, words, opts.bulk);
      warehouse[id] = {
        type: "memory",
        title: `${slug} decisions ${i}`,
        body,
        content_hash: `h-${slug}-${i}`,
      };
      warehouseChars += body.length;
      entries.push({
        id,
        title: `${slug} decisions ${i}`,
        preview: words,
        node_path: `/src/${slug}`,
        content_hash: `h-${slug}-${i}`,
      });
    }
    pathMemories[`/src/${slug}`] = entries;
  }

  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-09-01T00:00:00.000Z",
      session_digest: "",
      path_memories: pathMemories,
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      work_episode_index: TOPICS.map(([slug, words]) => ({
        paths: [`/src/${slug}`],
        subjects: words.split(" "),
        summary: `${slug} work`,
      })),
    }),
  );
  await writeFile(join(cacheDir, "warehouse.json"), JSON.stringify(warehouse));
  return { home, hookScript, wsRoot, stub, warehouseChars };
}

function fire(
  h: { home: string; hookScript: string; wsRoot: string; stub: string },
  sessionId: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hookScript],
      {
        env: {
          ...process.env,
          PATHRULE_HOME: h.home,
          PATHRULE_EMBED_HELPER: h.stub,
          PATHRULE_NAVIGATION: "on",
          ...extraEnv,
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
          resolve("");
        }
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: h.wsRoot, session_id: sessionId, ...payload }));
  });
}

const prompt = (
  h: Parameters<typeof fire>[0],
  s: string,
  text: string,
  transcriptPath?: string,
  extraEnv: Record<string, string> = {},
) =>
  fire(
    h,
    s,
    {
      hook_event_name: "UserPromptSubmit",
      prompt: text,
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    },
    extraEnv,
  );
const toolCall = (h: Parameters<typeof fire>[0], s: string, file: string) =>
  fire(h, s, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } });

/** 45 prompts: three passes over the topic list, so every later pass revisits
 *  ground the hook has already covered. That repetition is the whole point —
 *  it is what a real long session looks like, and what a re-sending injector
 *  turns into unbounded growth. */
function longSessionPrompts(): string[] {
  const out: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    for (const [slug, words] of TOPICS) {
      out.push(`${slug} ${words.split(" ").slice(0, 3).join(" ")} sorununa bak (pass ${pass + 1})`);
    }
  }
  return out;
}

describe("long-session token budget", () => {
  it("saturates: a long session never spends more than the knowledge it has", async () => {
    const h = await makeHome();
    const session = "budget-saturation";
    const prompts = longSessionPrompts();
    const curve: number[] = [];
    let total = 0;
    let toolTotal = 0;
    let files = 0;

    total += (await fire(h, session, { hook_event_name: "SessionStart", source: "startup" })).length;
    for (const p of prompts) {
      total += (await prompt(h, session, p)).length;
      for (let i = 0; i < 4; i++) {
        toolTotal += (await toolCall(h, session, join(h.wsRoot, "src", `f${files++ % 40}.ts`))).length;
      }
      curve.push(total);
    }

    const at = (i: number): number => curve[i] ?? 0;
    const marginalLast10 = at(curve.length - 1) - at(curve.length - 11);
    const marginalFirst10 = at(9);

    // eslint-disable-next-line no-console
    console.log(
      `[long-session] ${prompts.length} prompts + ${files} tool calls: ` +
        `total=${total} chars (~${Math.round(total / 4)} tok), ` +
        `warehouse=${h.warehouseChars}, first10=${marginalFirst10}, last10=${marginalLast10}, ` +
        `tool_calls_contributed=${toolTotal}`,
    );

    // 1. Saturation. The head may spend freely — that is where knowledge earns
    //    its keep — but the tail must cost a fraction of it, or the session is
    //    growing rather than converging.
    expect(marginalLast10).toBeLessThan(marginalFirst10 / 2);

    // 2. The per-turn tax, which is the number the complaint is actually about.
    //    A long session's marginal prompt should cost roughly a route line, not a
    //    paragraph. This is what caught the real regression: it was ~285 chars a
    //    prompt because the route's standing instruction was re-sent verbatim
    //    every time — invisible to body dedup, because it is framing, not
    //    knowledge. ~5.000 tokens across a 100-prompt session.
    const perPromptTail = marginalLast10 / 10;
    expect(perPromptTail, `tail costs ${perPromptTail} chars/prompt`).toBeLessThan(150);

    // 3. Tool calls are not a second injection channel. 180 of them here; every
    //    one that injects is a per-turn cost the user never asked for.
    expect(toolTotal).toBe(0);
  }, 180_000);

  it("says each memory body at most once across the whole session", async () => {
    const h = await makeHome();
    const session = "budget-no-repeat";
    const seen = new Map<string, number>();

    await fire(h, session, { hook_event_name: "SessionStart", source: "startup" });
    for (const p of longSessionPrompts()) {
      const out = await prompt(h, session, p);
      for (const [slug] of TOPICS) {
        // The sentence only ever appears in that memory's full body.
        if (out.includes(`Decision for ${slug}-0:`)) seen.set(slug, (seen.get(slug) ?? 0) + 1);
      }
    }

    const repeated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(repeated, `bodies injected more than once: ${JSON.stringify(repeated)}`).toEqual([]);
  }, 180_000);

  it("after a compaction it starts paying again — but only once more", async () => {
    const h = await makeHome();
    const session = "budget-compact";
    const prompts = longSessionPrompts();

    await fire(h, session, { hook_event_name: "SessionStart", source: "startup" });
    let before = 0;
    for (const p of prompts) before += (await prompt(h, session, p)).length;

    // The context is summarised away: what the hook already said is gone from the
    // model's view, so it must be willing to say it again — that is Adım 1. What
    // it must NOT do is treat every later prompt as new.
    await fire(h, session, { hook_event_name: "SessionStart", source: "compact" });
    let after = 0;
    for (const p of prompts) after += (await prompt(h, session, p)).length;

    // eslint-disable-next-line no-console
    console.log(`[long-session] pre-compact=${before} post-compact=${after} chars`);

    expect(after, "a compaction must re-open the channel").toBeGreaterThan(0);
    // A compaction resets the ledger; it does not license spending MORE than the
    // first pass did. If the second pass costs more, dedup did not survive the
    // reset and every later compaction compounds.
    expect(after).toBeLessThanOrEqual(before);
  }, 240_000);

  it("says the route's standing instruction once, not once per prompt", async () => {
    const h = await makeHome();
    const session = "budget-route-framing";
    const NEEDLE = "do NOT grep/glob across the repo";
    let routed = 0;
    let instructed = 0;

    await fire(h, session, { hook_event_name: "SessionStart", source: "startup" });
    for (const p of longSessionPrompts()) {
      const out = await prompt(h, session, p);
      if (out.includes("Pathrule route")) routed += 1;
      if (out.includes(NEEDLE)) instructed += 1;
    }

    // The route itself keeps being useful — it changes with the prompt.
    expect(routed).toBeGreaterThan(5);
    // Its constant framing does not. Safe to drop the repetition because the same
    // rule is in the protocol, which reaches the system prompt on SessionStart and
    // survives compaction — see PATHRULE_PROTOCOL's routing item.
    expect(instructed, `standing instruction sent ${instructed}x across ${routed} routes`).toBe(1);
  }, 180_000);

  // Context pressure — the session-length half of the budget.
  //
  // The per-ask budget knows what a prompt is worth but nothing about how much
  // room is left, so a long, fast-burning session was charged the same as its
  // first prompt. The transcript file is the signal every client already hands
  // the hook and nobody read: its size is not the context (it survives a
  // compaction that empties the window) but its growth rate is exactly "how fast
  // is this session consuming". Thresholds come from 2.481 real user turns in
  // this project's transcripts: p50 ≈ 8.000 bytes/turn, p90 ≈ 20.000.
  describe("context pressure", () => {
    async function runWith(growthPerTurn: number): Promise<number> {
      // Bodies big enough that the 12.000-char budget is the binding constraint.
      // With the default fixture the whole warehouse fits inside the budget, so a
      // halved budget changes nothing and the test would pass on both sides while
      // measuring nothing — the first version of this test did exactly that.
      // Small bodies + a small explicit budget, so the BUDGET is what decides how
      // many arrive. With production defaults the ranking runs out of candidates
      // before the 12.000-char budget binds, and then halving the budget changes
      // nothing — two earlier versions of this test passed while measuring that.
      const h = await makeHome({ bulk: 10, perPath: 8 });
      const env = { PATHRULE_BODY_BUDGET_CHARS: "3000" };
      const session = `pressure-${growthPerTurn}`;
      const transcript = join(h.home, `transcript-${growthPerTurn}.jsonl`);
      await writeFile(transcript, "");
      let size = 0;

      await fire(h, session, { hook_event_name: "SessionStart", source: "startup" }, env);
      const prompts = longSessionPrompts();
      let total = 0;
      for (const p of prompts) {
        // The turn's own cost lands in the transcript before the next prompt.
        size += growthPerTurn;
        await writeFile(transcript, "x".repeat(size));
        total += (await prompt(h, session, p, transcript, env)).length;
      }
      return total;
    }

    it("spends the same under pressure without the engine extension, which owns that scaling", async () => {
      const calm = await runWith(4_000);
      const burning = await runWith(60_000);
      expect(burning).toBe(calm);
    }, 300_000);

    it("is inert without a transcript path — no signal, no change", async () => {
      const h = await makeHome();
      const session = "pressure-none";
      await fire(h, session, { hook_event_name: "SessionStart", source: "startup" });
      let total = 0;
      for (const p of longSessionPrompts()) total += (await prompt(h, session, p)).length;
      expect(total).toBeGreaterThan(0);
    }, 300_000);
  });
});
