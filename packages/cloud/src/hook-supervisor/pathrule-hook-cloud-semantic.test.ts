// SPDX-License-Identifier: Apache-2.0
// Cloud semantic body ranking (2026-08-23) — production-shaped black box.
//
// What this pins. A signed-in account never supplies an embedding key: ranking is
// part of what Pathrule sells, so `embed-query.cjs`'s BYO path is the LOCAL
// edition's deal. Measured before this change: 56 of 56 body injections came back
// `fallback_no_key`, the relevance floor was bypassed on every prompt, and volume
// was bounded by the 12.000-char budget rather than by relevance. The hook now
// spawns the helper with the endpoint stamped into `hook-index.json` and uses the
// RANKED CANDIDATES Pathrule Cloud returns, where the floor already lives.
//
// Why a stub helper and not a live call: the helper is the seam, exactly as the
// tests of the global slim pool use it. The assertions below are about what the hook DOES with each
// helper outcome, which is the part that regressed.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// The open hook with the cloud extension beside it. How the engine's affinity boost orders what the
// server returns is the official composition's test (packages/app/src/test/hook/hook-cloud-ranking-affinity.test.ts).
const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../../integrations/src/hook-supervisor/pathrule-hook.js");
const CLOUD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook-cloud.cjs");
const WS_ID = "44444444-4444-4444-4444-444444444444";
const MEM_IDS = ["c-one", "c-two", "c-three"] as const;
const bodyOf = (id: string) => `BODY_${id}_cloudmarker`;

/** A signed-in Pathrule Cloud session on this machine. */
const nativeSessionFile = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  base_url: "https://cloud.example.test",
  user_id: "person-a",
  token: "native-tok",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

/**
 * @param helperBody JS body for the stub helper. It stands in for embed-query.cjs,
 *   so its stdout shape and exit code ARE the contract under test.
 * @param cloudBlock the `cloud_semantic` block in hook-index.json. `null` omits it,
 *   which is how a local-written index looks.
 */
async function makeHome(opts: {
  helperBody: string;
  cloudBlock?: { url: string; kind: "native" } | null;
  /** What lands in ~/.pathrule/native-session.json (Pathrule Cloud); `null` writes none. */
  nativeSession?: Record<string, unknown> | null;
}) {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-cloud-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);
  await copyFile(CLOUD_EXTENSION, join(dirname(hookScript), "pathrule-hook-cloud.cjs"));

  const stub = join(home, "bin", "stub-helper.cjs");
  await writeFile(stub, opts.helperBody);

  if (opts.nativeSession !== null) {
    await writeFile(
      join(home, "native-session.json"),
      JSON.stringify(opts.nativeSession ?? nativeSessionFile()),
    );
  }

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
      indexed_memory_ids: [...MEM_IDS],
      path_memories: {
        "/lib": MEM_IDS.map((id) => ({
          id,
          title: `Memory ${id}`,
          preview: "about caching",
          node_path: "/lib",
          content_hash: `h-${id}`,
        })),
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      ...(opts.cloudBlock === null
        ? {}
        : {
            cloud_semantic:
              opts.cloudBlock ?? { url: "https://cloud.example.test", kind: "native" },
          }),
    }),
  );

  await writeFile(
    join(cacheDir, "warehouse.json"),
    JSON.stringify(
      Object.fromEntries(
        MEM_IDS.map((id) => [
          id,
          { type: "memory", title: `Memory ${id}`, body: bodyOf(id), content_hash: `h-${id}` },
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
          // Kept unset on purpose: a cloud account has no provider key, and the
          // point of the cloud path is that it does not need one.
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

/** Stub that echoes back a fixed candidate list, i.e. a healthy cloud response. */
const candidateHelper = (candidates: unknown[]) =>
  `const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{
     process.stdout.write(JSON.stringify({candidates:${JSON.stringify(candidates)},model:"stub-cloud"}));
     process.exit(0);
   });`;

/** Stub that records the env it was handed, so we can assert what the hook passed. */
const envRecordingHelper = (outFile: string) =>
  `const fs=require("fs");const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{
     fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
       url: process.env.PATHRULE_CLOUD_SEMANTIC_URL || "",
       token: process.env.PATHRULE_CLOUD_SEMANTIC_TOKEN || "",
       workspace: process.env.PATHRULE_CLOUD_SEMANTIC_WORKSPACE || "",
       root_path: process.env.PATHRULE_CLOUD_SEMANTIC_ROOT_PATH || "",
       timeout: process.env.PATHRULE_CLOUD_SEMANTIC_TIMEOUT_MS || "",
       min: process.env.PATHRULE_CLOUD_SEMANTIC_MIN_SIMILARITY || "",
     }));
     process.stdout.write(JSON.stringify({candidates:[{id:"c-two",similarity:0.9,affinity_decayed_weight:0}]}));
     process.exit(0);
   });`;

describe("cloud semantic body ranking", () => {
  it("injects the bodies the server ranked, in the server's order", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: candidateHelper([
        { id: "c-three", similarity: 0.91, affinity_decayed_weight: 0 },
        { id: "c-one", similarity: 0.62, affinity_decayed_weight: 0 },
      ]),
    });
    const out = await runPrompt(home, hookScript, wsRoot, stub, "how does caching work", "s-rank");

    expect(out).toContain(bodyOf("c-three"));
    expect(out).toContain(bodyOf("c-one"));
    // c-two was NOT returned by the server, so it must not appear. Before this
    // change the lexical fallback had no floor and every candidate stayed eligible.
    expect(out).not.toContain(bodyOf("c-two"));
    // Server order is authoritative: the higher-similarity body comes first.
    expect(out.indexOf(bodyOf("c-three"))).toBeLessThan(out.indexOf(bodyOf("c-one")));
  });

  it("injects NO body when the server cleared nothing, instead of falling back to keyword overlap", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: candidateHelper([]),
    });
    const out = await runPrompt(home, hookScript, wsRoot, stub, "caching and memory and lib", "s-empty");

    // This is the whole point of having a floor. An empty server verdict means
    // "nothing is relevant"; re-running keyword overlap here would undo it and put
    // the budget back in charge of how much gets injected.
    for (const id of MEM_IDS) expect(out).not.toContain(bodyOf(id));
  });

  it("passes the endpoint from hook-index and no token of its own: the helper reads the session", async () => {
    const home0 = await mkdtemp(join(tmpdir(), "pathrule-hook-cloud-env-"));
    homes.push(home0);
    const envOut = join(home0, "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-env");

    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    // The helper sends the native session only to its own origin
    // (the Cloud service's own tests).
    expect(seen.url).toBe("https://cloud.example.test");
    expect(seen.token).toBe("");
    expect(seen.workspace).toBe(WS_ID);
  });

  // Recall and ranking are separate jobs, and conflating them cost every candidate.
  //
  // The hook used to send the routed path as the edge function's `root_path`, which the RPC
  // uses as a FILTER. Measured 2026-08-23: a routed file as root_path took a prompt from 3
  // candidates to 0, and a routed folder took two prompts from 3 and 1 to 0 and 0. The slim pool is global precisely so a weak
  // route cannot cause a miss; sending the route re-introduced the miss on the server side,
  // where the client could not even see it happen.
  it("recalls globally and never sends a root_path filter", async () => {
    const home0 = await mkdtemp(join(tmpdir(), "pathrule-hook-cloud-root-"));
    homes.push(home0);
    const envOut = join(home0, "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-root");

    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    expect(seen.root_path ?? "").toBe("");
  });

  // Cloud candidates are ranked by `similarity × pathRelationTier × proven`, and the tier
  // STANDS DOWN when no path relation has been established — every candidate lands in the
  // "elsewhere" tier and similarity alone decides. Inventing a relation from an empty route
  // would be guessing with a multiplier, which is worse than not weighting at all.
  //
  // A prompt with no routed path is exactly that case, so this pins the fallback rather than
  // the weighting. The weighting itself is covered where a path actually exists:
  // pathrule-hook-name-channel.test.ts drives a real file event through pathRelationTier.
  it("orders cloud candidates by similarity when no path relation is established", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: candidateHelper([
        { id: "c-one", similarity: 0.62, affinity_decayed_weight: 0, node_path: "/unrelated/area" },
        { id: "c-three", similarity: 0.55, affinity_decayed_weight: 0, node_path: "/lib" },
      ]),
    });
    const out = await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-tier");

    expect(out.indexOf(bodyOf("c-one"))).toBeLessThan(out.indexOf(bodyOf("c-three")));
  });

  it("offers a server-ranked candidate we hold no body for, by name", async () => {
    // The server knows the whole workspace; the client's warehouse is a slice. Returning
    // nothing in that case threw away a correct answer — measured as `cloud_no_local_body`
    // on a real prompt whose top candidate simply was not in the local pool.
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: candidateHelper([
        { id: "not-local-1", similarity: 0.71, affinity_decayed_weight: 0, title: "Server only memory", node_path: "/lib" },
      ]),
    });
    const out = await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-serveronly");

    expect(out).toContain("Server only memory");
    expect(out).toContain("(id: not-local-1)");
  });

  it("stays on the local path when the index carries no cloud block", async () => {
    const envOut = join(await mkdtemp(join(tmpdir(), "pathrule-hook-nocloud-")), "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
      cloudBlock: null,
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-local");

    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    // No cloud env at all: this is the local/OSS edition, whose deal is its own key.
    expect(seen.url).toBe("");
    expect(seen.token).toBe("");
  });

  // The defect this pins was invisible because NOTHING asserted the helper receives a
  // budget. There were two: spawnSync's timeout, and the helper's own fetch abort, which
  // defaulted to 2.600 by itself. So the hook raising CLOUD_SEMANTIC_TIMEOUT_MS to 3.500
  // changed nothing -- the helper still aborted first, exited 1, and exit 1 reads as an
  // ERROR, not a timeout, which TRIPS THE BREAKER and drops the next 10 minutes of
  // prompts to keyword overlap. For a Turkish prompt keyword overlap returns nothing, so
  // one slow call cost ten minutes of knowledge. Measured n=12 against the live endpoint:
  // p50 2.045 ms, p90 2.157, max 2.376 -- 9% of headroom under 2.600.
  it("hands the helper the same timeout budget the hook is configured with", async () => {
    const envOut = join(await mkdtemp(join(tmpdir(), "pathrule-hook-budget-")), "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-budget");

    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    // Present at all is the assertion that matters; an empty string means the helper is
    // back to picking its own number and the two budgets have drifted apart again.
    expect(seen.timeout).not.toBe("");
    expect(Number(seen.timeout)).toBe(3500);
  });

  // The floor was a bare literal, which made it unsweepable: a sweep that set the env var
  // measured NOTHING while looking like it worked, because cloudSemanticEnv overwrote the
  // variable on the way out -- 0.45 and 0.40 came back byte-identical. 0.40 is the measured
  // default: the same memory scores 0.625 against an English prompt and 0.590 against its
  // Turkish translation, so a floor tuned on English silently cuts the other language.
  it("sends the measured 0.40 floor by default and honours an override", async () => {
    const envOut = join(await mkdtemp(join(tmpdir(), "pathrule-hook-floor-")), "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-floor");
    const fs = await import("node:fs/promises");
    expect(Number(JSON.parse(await fs.readFile(envOut, "utf8")).min)).toBeCloseTo(0.4, 5);

    const envOut2 = join(await mkdtemp(join(tmpdir(), "pathrule-hook-floor2-")), "seen-env.json");
    const b = await makeHome({ helperBody: envRecordingHelper(envOut2) });
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [b.hookScript],
        {
          env: {
            ...process.env,
            PATHRULE_HOME: b.home,
            PATHRULE_HOOK_EVENT: "UserPromptSubmit",
            PATHRULE_NAVIGATION: "on",
            PATHRULE_EMBED_HELPER: b.stub,
            PATHRULE_EMBEDDING_PROVIDER: "",
            PATHRULE_EMBEDDING_API_KEY: "",
            PATHRULE_INJECT_MIN_SIMILARITY: "0.33",
          },
          timeout: 10_000,
        },
        (error) => (error && typeof error.code === "number" && error.code !== 0 ? reject(error) : resolve()),
      );
      child.stdin!.end(
        JSON.stringify({
          cwd: b.wsRoot,
          prompt: "caching question",
          session_id: "s-floor-override",
          hook_event_name: "UserPromptSubmit",
        }),
      );
    });
    expect(Number(JSON.parse(await fs.readFile(envOut2, "utf8")).min)).toBeCloseTo(0.33, 5);
  });

  it("does not reach for the cloud without a session on this machine", async () => {
    const envOut = join(await mkdtemp(join(tmpdir(), "pathrule-hook-signedout-")), "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
      nativeSession: null,
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-signedout");

    // Signed out: the hook ranks locally, so the stub ran without the cloud env.
    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    expect(seen.url).toBe("");
  });

  it("ignores a cloud block of any other kind", async () => {
    const envOut = join(await mkdtemp(join(tmpdir(), "pathrule-hook-otherkind-")), "seen-env.json");
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: envRecordingHelper(envOut),
      cloudBlock: { url: "https://cloud.example.test" } as unknown as { url: string; kind: "native" },
    });
    await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-otherkind");
    const seen = JSON.parse(await (await import("node:fs/promises")).readFile(envOut, "utf8"));
    expect(seen.url).toBe("");
  });

  // Control, and the reason the assertions above are not vacuous. A payload the
  // hook does not recognise as EITHER shape must not be read as a cloud verdict: it
  // leaves the hook on the keyword-overlap path. Every candidate here previews
  // "about caching" and the prompt says "caching", so all three overlap, the
  // calibrated gate has nothing to drop, and all three bodies land.
  //
  // That is what separates this from the "injects NO body" case above: there the
  // SERVER returned an empty ranking, which is a verdict and is respected; here
  // nothing ranked at all, so suppressing would be inventing a verdict. Run against
  // the pre-change hook, a candidates payload landed on this same path — which is
  // why the cloud tests above would fail there.
  //
  // The gate's own drop/stand-down behaviour is pinned separately, with a fixture
  // whose previews differ: pathrule-hook-lexical-floor.test.ts.
  it("treats an unrecognised helper payload as no ranking at all, not as an empty verdict", async () => {
    const { home, hookScript, wsRoot, stub } = await makeHome({
      helperBody: `const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{
        process.stdout.write(JSON.stringify({unrecognised:true}));process.exit(0);});`,
    });
    const out = await runPrompt(home, hookScript, wsRoot, stub, "caching question", "s-control");

    // Delivery continues (not an empty verdict): every candidate is offered. One shared word earns a
    // name rather than a body, so the offer is by name here.
    expect(out).toContain("names only");
    for (const id of MEM_IDS) expect(out).toContain(`(id: ${id})`);
  });
});
