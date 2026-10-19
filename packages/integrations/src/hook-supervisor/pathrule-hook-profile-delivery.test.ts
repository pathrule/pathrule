// SPDX-License-Identifier: Apache-2.0
// Team and personal profiles through the hook (after Studio).
//
// Verified organization profiles and a person's console-managed preferences used to reach an agent
// only inside Studio's compiled turns. The account now stamps them on the hook index
// (`intelligence_profiles`: the provider's selection for a session without a request, rendered and
// bounded), and the hook delivers the block as framing: at the session start, once per session and
// version, after the protocol. A changed block reaches a running Claude Code or Codex session on its
// next prompt. Personal entries are one person's, so the block goes out only while the account it
// was selected for is signed in on this machine.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { clearAccountOwner, recordAccountOwner } from "@pathrule/core/storage/account-owners.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "88888888-8888-8888-8888-888888888888";
const OWNER = "person-a";
const PROTOCOL = "# Pathrule protocol\n\n1. PROTOCOL_MARKER obey surfaced rules.";
const BLOCK_V1 =
  "## Team and personal profiles (human-managed)\n### Verified organization profile\n- [high · testing · relevance 0.80] PROFILE_V1 write tests first.";
const BLOCK_V2 =
  "## Team and personal profiles (human-managed)\n### Verified organization profile\n- [high · testing · relevance 0.80] PROFILE_V2 write tests first.";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })));
});

interface Home {
  home: string;
  hookScript: string;
  wsRoot: string;
  stub: string;
  indexPath: string;
}

async function makeHome(
  opts: { signedIn?: string | null; protocol?: boolean } = {},
): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-profiles-"));
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
  const indexPath = join(cacheDir, "hook-index.json");
  const index: Record<string, unknown> = {
    workspace_id: WS_ID,
    workspace_root: wsRoot,
    generated_at: "2026-10-08T00:00:00.000Z",
    session_digest: "📋 Recent: DIGEST_MARKER touched the auth service.",
    path_memories: {},
    path_rules: {},
    project_rules: [],
    intelligence_profiles: {
      owner: OWNER,
      version: "intelligence:v1",
      block: BLOCK_V1,
      ids: ["t-1"],
    },
  };
  if (opts.protocol) index.protocol = PROTOCOL;
  await writeFile(indexPath, JSON.stringify(index));
  const signedIn = opts.signedIn === undefined ? OWNER : opts.signedIn;
  if (signedIn) await recordAccountOwner("native", signedIn, { PATHRULE_HOME: home });
  return { home, hookScript, wsRoot, stub, indexPath };
}

async function setBlock(h: Home, version: string, block: string): Promise<void> {
  const index = JSON.parse(await readFile(h.indexPath, "utf8")) as Record<string, unknown>;
  index.intelligence_profiles = { owner: OWNER, version, block, ids: ["t-1"] };
  await writeFile(h.indexPath, JSON.stringify(index));
}

function run(h: Home, event: string, payload: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hookScript],
      {
        // HOME too, so the hook's second credentials location is this scratch home, never the
        // machine's real sign-in.
        env: {
          ...process.env,
          HOME: h.home,
          PATHRULE_HOME: h.home,
          PATHRULE_HOOK_EVENT: event,
          PATHRULE_EMBED_HELPER: h.stub,
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) {
          reject(new Error(`hook exited ${error.code}: ${stdout}`));
          return;
        }
        try {
          const out = JSON.parse(stdout.trim());
          resolve(out?.hookSpecificOutput?.additionalContext ?? out?.additional_context ?? "");
        } catch {
          resolve(stdout.trim());
        }
      },
    );
    child.stdin!.end(JSON.stringify({ cwd: h.wsRoot, ...payload }));
  });
}

const sessionStart = (h: Home, session: string, source = "startup") =>
  run(h, "SessionStart", {
    session_id: session,
    hook_event_name: "SessionStart",
    transcript_path: "/tmp/transcript.jsonl",
    source,
  });
const prompt = (h: Home, session: string) =>
  run(h, "UserPromptSubmit", {
    session_id: session,
    hook_event_name: "UserPromptSubmit",
    prompt: "fix the auth caching bug",
  });

describe("hook team and personal profile delivery", () => {
  it("delivers the block at the session start, after the protocol, and not again on the prompt", async () => {
    const h = await makeHome({ protocol: true });
    const start = await sessionStart(h, "s-start");
    expect(start).toContain("PROFILE_V1");
    expect(start.indexOf("PROTOCOL_MARKER")).toBeLessThan(start.indexOf("PROFILE_V1"));
    expect(await prompt(h, "s-start")).not.toContain("PROFILE_V1");
    // A repeated startup is not a context reset.
    expect(await sessionStart(h, "s-start")).not.toContain("PROFILE_V1");
  });

  it("delivers it on the first prompt when the session start never reached the hook", async () => {
    const h = await makeHome();
    const first = await prompt(h, "s-prompt");
    expect(first).toContain("PROFILE_V1");
    expect(await prompt(h, "s-prompt")).not.toContain("PROFILE_V1");
  });

  it("delivers a changed block once on the next prompt, and again after a compaction", async () => {
    const h = await makeHome();
    expect(await sessionStart(h, "s-change")).toContain("PROFILE_V1");
    await setBlock(h, "intelligence:v2", BLOCK_V2);
    const next = await prompt(h, "s-change");
    expect(next).toContain("PROFILE_V2");
    expect(next).not.toContain("PROFILE_V1");
    expect(await prompt(h, "s-change")).not.toContain("PROFILE_V2");
    // The compaction summarised the delivered block away: the session start brings it back.
    expect(await sessionStart(h, "s-change", "compact")).toContain("PROFILE_V2");
  });

  it("delivers nothing while nobody, or another account, is signed in", async () => {
    const signedOut = await makeHome({ signedIn: null });
    expect(await sessionStart(signedOut, "s-out")).not.toContain("PROFILE_V1");
    expect(await prompt(signedOut, "s-out")).not.toContain("PROFILE_V1");

    const other = await makeHome({ signedIn: "person-b" });
    const start = await sessionStart(other, "s-other");
    expect(start).not.toContain("PROFILE_V1");
    // Still doing its normal job, so the silence is not an empty payload.
    expect(start).toContain("DIGEST_MARKER");
    expect(await prompt(other, "s-other")).not.toContain("PROFILE_V1");
  });

  it("leaves the session start unchanged when the index carries no block", async () => {
    const h = await makeHome();
    const index = JSON.parse(await readFile(h.indexPath, "utf8")) as Record<string, unknown>;
    delete index.intelligence_profiles;
    await writeFile(h.indexPath, JSON.stringify(index));
    const start = await sessionStart(h, "s-none");
    expect(start).not.toContain("Team and personal profiles");
    expect(start).toContain("DIGEST_MARKER");
  });

  it("reaches Cursor at its session start, the one event that carries context there", async () => {
    const h = await makeHome();
    const cursorPrompt = await run(h, "UserPromptSubmit", {
      conversation_id: "s-cursor",
      cursor_version: "1.7.0",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "fix the auth caching bug",
    });
    expect(cursorPrompt).not.toContain("PROFILE_V1");
    const start = await run(h, "SessionStart", {
      conversation_id: "s-cursor",
      cursor_version: "1.7.0",
      hook_event_name: "sessionStart",
    });
    expect(start).toContain("PROFILE_V1");
  });

  // Studio set PATHRULE_STUDIO_CONTEXT_INJECTED on the engines it spawned so the hook stood down.
  // Studio is gone; a leftover flag must not keep the profile from the session start.
  it("ignores the retired Studio stand-down flag", async () => {
    const h = await makeHome();
    const out = await new Promise<string>((resolve) => {
      const child = execFile(
        process.execPath,
        [h.hookScript],
        {
          env: {
            ...process.env,
            HOME: h.home,
            PATHRULE_HOME: h.home,
            PATHRULE_HOOK_EVENT: "SessionStart",
            PATHRULE_EMBED_HELPER: h.stub,
            PATHRULE_STUDIO_CONTEXT_INJECTED: "1",
          },
          timeout: 15_000,
        },
        (_error, stdout) => resolve(stdout),
      );
      child.stdin!.end(
        JSON.stringify({ cwd: h.wsRoot, session_id: "s-studio", hook_event_name: "SessionStart" }),
      );
    });
    expect(out).toContain("PROFILE_V1");
  });
});

// A provider records the owner it authenticated in account-owners.json; core writes it, the hook
// reads it.
describe("an owner a provider recorded", () => {
  it("gets the block while recorded, and nothing after the provider clears it", async () => {
    const h = await makeHome({ signedIn: null });
    expect(await sessionStart(h, "s-native-before")).not.toContain("PROFILE_V1");

    await recordAccountOwner("native", OWNER, { PATHRULE_HOME: h.home });
    expect(await sessionStart(h, "s-native")).toContain("PROFILE_V1");

    await clearAccountOwner("native", { PATHRULE_HOME: h.home });
    expect(await sessionStart(h, "s-native-after")).not.toContain("PROFILE_V1");
  });

  it("keeps another account's block out after an account switch", async () => {
    const h = await makeHome({ signedIn: null });
    await recordAccountOwner("native", OWNER, { PATHRULE_HOME: h.home });
    await recordAccountOwner("native", "person-b", { PATHRULE_HOME: h.home });
    expect(await sessionStart(h, "s-switched")).not.toContain("PROFILE_V1");
  });

  it("is recognised without writing or reading any credential slot for it", async () => {
    const h = await makeHome({ signedIn: null });
    await recordAccountOwner("native", OWNER, { PATHRULE_HOME: h.home });
    expect(await sessionStart(h, "s-no-slot")).toContain("PROFILE_V1");
    await expect(readFile(join(h.home, "credentials.json"), "utf8")).rejects.toThrow();
  });
});
