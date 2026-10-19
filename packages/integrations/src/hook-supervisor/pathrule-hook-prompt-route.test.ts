// SPDX-License-Identifier: Apache-2.0
// One route per prompt, two consumers. The navigation router's route is what the
// navigation block emits AND what the non-Claude semantic candidates tier against.
//
// The candidates used to read a `route` declared inside the navigation block, so on
// every non-Claude discovery prompt ("where…", "which…", "find…", "debug…") the hook
// threw a ReferenceError and exited 1 with no context at all. No test sent a Codex
// prompt, which is how it stayed invisible from 2026-08-23 on. These run the real hook
// as a child process: only the inlined copy in pathrule-hook.js runs in the product.

import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "44444444-4444-4444-4444-444444444444";
const PROMPT = "where does the billing webhook handler live?";
const CANDIDATES_HEADER = "Possible semantic memory candidates";
const ROUTE_LINE = /^- \/packages\/billing — .*$/m;

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function makeHome(): Promise<{ home: string; hookScript: string; wsRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-prompt-route-"));
  homes.push(home);
  const hookScript = join(home, "bin", "pathrule-hook.js");
  await mkdir(dirname(hookScript), { recursive: true });
  await copyFile(HOOK_SCRIPT_SOURCE, hookScript);

  const wsRoot = join(home, "project");
  await mkdir(wsRoot, { recursive: true });
  const cacheDir = join(home, "cache", WS_ID);
  await mkdir(cacheDir, { recursive: true });

  await writeFile(
    join(cacheDir, "hook-index.json"),
    JSON.stringify({
      workspace_id: WS_ID,
      workspace_root: wsRoot,
      generated_at: "2026-10-06T00:00:00.000Z",
      session_digest: "",
      // Both memories share exactly ONE token with the prompt, so each scores 3 × its path
      // tier against a floor of 3: only a memory on the routed path clears it. That makes
      // the candidate list a direct reading of which path the tiering was handed.
      path_memories: {
        "/packages/billing": [
          {
            id: "mem-routed",
            title: "Signature verification",
            preview: "verify the webhook signature",
            node_path: "/packages/billing",
            content_hash: "h1",
          },
        ],
        "/packages/search": [
          {
            id: "mem-elsewhere",
            title: "Search pagination",
            preview: "the handler returns pages",
            node_path: "/packages/search",
            content_hash: "h2",
          },
        ],
      },
      path_rules: {},
      project_rules: [],
      recent_subjects: [],
      // Routes PROMPT to /packages/billing with a strong score.
      work_episode_index: [
        {
          paths: ["/packages/billing"],
          subjects: ["billing", "webhook"],
          summary: "billing webhooks",
        },
      ],
    }),
  );

  return { home, hookScript, wsRoot };
}

interface HookRun {
  code: number | null;
  stderr: string;
  context: string;
}

function runPrompt(
  h: { home: string; hookScript: string; wsRoot: string },
  client: "claude" | "codex",
  prompt: string,
  sessionId: string,
  navigation = "on",
): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [h.hookScript], {
      env: {
        ...process.env,
        PATHRULE_HOME: h.home,
        PATHRULE_HOOK_EVENT: "UserPromptSubmit",
        PATHRULE_NAVIGATION: navigation,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      let context = "";
      try {
        context = JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "";
      } catch {
        context = stdout.trim();
      }
      resolve({ code, stderr, context });
    });
    // `turn_id` + `model` is what marks a Codex UserPromptSubmit payload.
    const codexFields = client === "codex" ? { turn_id: "turn-1", model: "gpt-5-codex" } : {};
    child.stdin.end(
      JSON.stringify({
        cwd: h.wsRoot,
        prompt,
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        ...codexFields,
      }),
    );
  });
}

describe("offline hook × the prompt route and its two consumers", () => {
  it("codex: a discovery prompt delivers context, with candidates tiered on the router's route", async () => {
    const h = await makeHome();
    const run = await runPrompt(h, "codex", PROMPT, "codex-route");
    expect(run.stderr).not.toContain("ReferenceError");
    expect(run.code).toBe(0);
    expect(run.context).toMatch(ROUTE_LINE);
    expect(run.context).toContain(CANDIDATES_HEADER);
    // Clears the floor only because the routed path is its own node.
    expect(run.context).toContain("id: mem-routed");
    // The same single-token match from an unrelated subtree stays below it.
    expect(run.context).not.toContain("mem-elsewhere");
  });

  it("codex: with no route there is no invented path relation, and still no crash", async () => {
    const h = await makeHome();
    // Navigation off: the router does not run, so the routed memory is just another
    // single-token match from elsewhere.
    const off = await runPrompt(h, "codex", PROMPT, "codex-nav-off", "off");
    expect(off.stderr).not.toContain("ReferenceError");
    expect(off.code).toBe(0);
    expect(off.context).not.toMatch(ROUTE_LINE);
    expect(off.context).not.toContain(CANDIDATES_HEADER);

    // A discovery prompt below the router's 15-character minimum took the same crash.
    const short = await runPrompt(h, "codex", "find webhook", "codex-short");
    expect(short.stderr).not.toContain("ReferenceError");
    expect(short.code).toBe(0);
    expect(short.context).not.toContain(CANDIDATES_HEADER);
  });

  it("claude: the same prompt emits the same route and no candidate block", async () => {
    const h = await makeHome();
    const claude = await runPrompt(h, "claude", PROMPT, "claude-route");
    expect(claude.code).toBe(0);
    expect(claude.stderr).toBe("");
    expect(claude.context).toMatch(ROUTE_LINE);
    // Claude is a slim client: its relevance channel is the body block, never these titles.
    expect(claude.context).not.toContain(CANDIDATES_HEADER);

    // One route, two consumers: the route Codex is shown is the one Claude is shown.
    const codex = await runPrompt(h, "codex", PROMPT, "codex-same-route");
    expect(codex.context.match(ROUTE_LINE)?.[0]).toBe(claude.context.match(ROUTE_LINE)?.[0]);
  });
});
