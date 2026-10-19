// SPDX-License-Identifier: Apache-2.0
// Learned preferences and guidance through the hook belong to a person.
//
// The accountless local person's entries (no `personal_owner`) are delivered on this machine as
// before. Entries compiled from an account's store carry that account as `personal_owner`, and the
// hook delivers them only while it is signed in here: the owner its sign-in recorded
// (account-owners.json). Logout, an account switch or a cleared owner stops them on the next
// prompt; project knowledge on the same index keeps flowing.

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { clearAccountOwner, recordAccountOwner } from "@pathrule/core/storage/account-owners.js";

const HOOK_SCRIPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pathrule-hook.js");
const WS_ID = "99999999-9999-9999-9999-999999999999";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

interface Home {
  home: string;
  hookScript: string;
  wsRoot: string;
  stub: string;
  indexPath: string;
}

async function makeHome(personal: { owner?: string }): Promise<Home> {
  const home = await mkdtemp(join(tmpdir(), "pathrule-hook-personal-"));
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
    generated_at: "2026-10-09T00:00:00.000Z",
    path_memories: {},
    path_rules: {},
    project_rules: [],
    user_preferences: [
      {
        id: "pref-1",
        line: "- PREF_MARKER prefers small reviewed commits.",
        terms: ["commit"],
        always: true,
      },
    ],
    guidance: [
      {
        id: "lease-1",
        heading: "Expertise",
        line: "- GUIDANCE_MARKER knows the auth code well.",
        terms: ["auth"],
      },
    ],
    ...(personal.owner ? { personal_owner: personal.owner } : {}),
  };
  await writeFile(indexPath, JSON.stringify(index));
  return { home, hookScript, wsRoot, stub, indexPath };
}

/** Sign in as `userId` (the owner the sign-in records), or sign out with null. */
async function signIn(h: Home, userId: string | null): Promise<void> {
  const env = { PATHRULE_HOME: h.home } as NodeJS.ProcessEnv;
  if (userId) await recordAccountOwner("native", userId, env);
  else await clearAccountOwner("native", env);
}

function prompt(h: Home, session: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [h.hookScript],
      {
        env: {
          ...process.env,
          HOME: h.home,
          PATHRULE_HOME: h.home,
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
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
    child.stdin!.end(
      JSON.stringify({
        cwd: h.wsRoot,
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "commit the auth fix",
      }),
    );
  });
}

describe("hook personal entries and their owner", () => {
  it("delivers the accountless local person's entries with nobody signed in", async () => {
    const h = await makeHome({});
    const out = await prompt(h, "s-local");
    expect(out).toContain("PREF_MARKER");
    expect(out).toContain("GUIDANCE_MARKER");
  });

  it("delivers an account's entries only while that account is signed in", async () => {
    const h = await makeHome({ owner: "person-a" });
    expect(await prompt(h, "s-none")).not.toContain("PREF_MARKER");

    await signIn(h, "person-b");
    const other = await prompt(h, "s-other");
    expect(other).not.toContain("PREF_MARKER");
    expect(other).not.toContain("GUIDANCE_MARKER");

    await signIn(h, "person-a");
    const owner = await prompt(h, "s-owner");
    expect(owner).toContain("PREF_MARKER");
    expect(owner).toContain("GUIDANCE_MARKER");

    // Logout: the owner is gone, so is the delivery, though the index still holds the entries.
    await signIn(h, null);
    expect(await prompt(h, "s-after-logout")).not.toContain("PREF_MARKER");
    expect(JSON.parse(await readFile(h.indexPath, "utf8")).user_preferences).toHaveLength(1);
  });

  it("recognises an owner a provider recorded, and stops when it is cleared or replaced", async () => {
    const h = await makeHome({ owner: "native-a" });
    const env = { PATHRULE_HOME: h.home } as NodeJS.ProcessEnv;
    await recordAccountOwner("native", "native-a", env);
    expect(await prompt(h, "s-native")).toContain("PREF_MARKER");

    await recordAccountOwner("native", "native-b", env);
    expect(await prompt(h, "s-switched")).not.toContain("PREF_MARKER");

    await recordAccountOwner("native", "native-a", env);
    await clearAccountOwner("native", env);
    expect(await prompt(h, "s-cleared")).not.toContain("PREF_MARKER");
  });
});
