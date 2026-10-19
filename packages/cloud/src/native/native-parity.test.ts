// SPDX-License-Identifier: Apache-2.0
// One person across the host's turn, MCP get_context and the hook when a native account binds a local
// workspace: the preferences are compiled from the bound person's store, the profiles are that
// person's, and the hook recognises that owner with no other session on the machine. An account
// switch stops the previous owner's block at the hook.
//
// Real code end to end over a local workspace (no account edition, PATHRULE_LOCAL): the host's own
// sources with the native edition, the get_context tool handler with the native person binding, the
// hook index writer and the hook script. Only the edge is a stand-in: a provider that binds a fixed
// owner with a fixed profile and that person's own in-memory store. No engine compiles turn guidance,
// so neither the turn nor get_context carries one.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalBackend } from "@pathrule/core";
import { captureUserPreference } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import {
  createMemoryUserKnowledgeStore,
  type UserKnowledgeStore,
} from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";
import { compileTurnContext, TurnContextCache } from "@pathrule/host/context/compile.js";
import { clearProjectLearningCache } from "@pathrule/host/context/project-context.js";
import { hostTurnSources } from "@pathrule/host/context/rpc.js";
import { WorkspaceStores } from "@pathrule/host/stores.js";
import { resetLocalBackends } from "@pathrule/mcp/local-runtime.js";
import { installMcpPlugins } from "@pathrule/mcp/plugin.js";
import { getContextTool } from "@pathrule/mcp/tools/get-context.js";
import { setProjectLearningBudgetForTest } from "@pathrule/mcp/tools/get-context-learning.js";
import { clearIntelligenceSectionMemory } from "@pathrule/mcp/tools/intelligence-sections.js";
import {
  HOOK_PROFILE_BLOCK_MAX_CHARS,
  intelligenceItemVersion,
} from "@pathrule/protocol/intelligence-delivery.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { IntelligenceProfileSource } from "../intelligence/profile-context.js";
import { createNativeAccount, type NativeWorkspaceMapping } from "./account.js";

const LOCAL = "ws-native-local";
const CLOUD = "native-cloud-ws";
const INTENT = "fix the flaky checkout test";
const HOOK_SCRIPT = join(__dirname, "../../../integrations/src/hook-supervisor/pathrule-hook.js");

/** A person's own store, holding one lasting habit they stated in this workspace. */
async function storeOf(who: string): Promise<UserKnowledgeStore> {
  const store = createMemoryUserKnowledgeStore();
  const quote = `rerun the checkout suite before a push, Preference of ${who}`;
  const captured = await captureUserPreference(
    store,
    {
      kind: "procedure",
      claim: `Rerun the checkout suite before a push (Preference of ${who}).`,
      quotes: [quote],
      lasting: true,
    },
    {
      workspaceId: LOCAL,
      words: [{ sid: "s0", at: "2026-10-15T00:00:00.000Z", text: `A habit of mine: ${quote}.` }],
      now: "2026-10-15T00:00:00.000Z",
    },
  );
  expect(captured).toMatchObject({ ok: true, status: "active" });
  return store;
}

function profiles(owner: string): IntelligenceProfileSource {
  return {
    async profileContext(input) {
      if (input.workspaceId !== CLOUD) return null;
      return {
        enabled: true,
        team_profile: [
          {
            id: `t-${owner}`,
            category: "testing",
            statement: `Run the checkout suite against the sandbox (${owner}).`,
            priority: "high",
            relevance_score: 0.8,
          },
        ],
        personal_profile: [
          {
            id: `p-${owner}`,
            category: "style",
            statement: `Prefers small reviewed commits (${owner}).`,
            priority: "medium",
            relevance_score: 0.6,
          },
        ],
      };
    },
  };
}

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const prevCwd = process.cwd();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-native-parity-")));
  repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  for (const key of [
    "PATHRULE_HOME",
    "PATHRULE_LOCAL",
    "PATHRULE_LOCAL_PRINCIPAL",
    "HOME",
    "PATHRULE_SIGNATURE_MODE",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.PATHRULE_HOME = home;
  process.env.HOME = home;
  process.env.PATHRULE_LOCAL = "1";
  process.env.PATHRULE_LOCAL_PRINCIPAL = "local-person";
  process.env.PATHRULE_SIGNATURE_MODE = "off";
  process.chdir(repo);
  setProjectLearningBudgetForTest(30_000);
  clearProjectLearningCache();
  clearIntelligenceSectionMemory();
});

afterEach(async () => {
  installMcpPlugins([]);
  setProjectLearningBudgetForTest(null);
  await resetLocalBackends();
  process.chdir(prevCwd);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function localWorkspace(): Promise<void> {
  const seed = LocalBackend.openForWorkspace(LOCAL, process.env);
  seed.registerWorkspace({ workspaceId: LOCAL, name: "repo", localRootPath: repo });
  const node = await seed.ensureNodeForPath(LOCAL, "/");
  await seed.writeMemory({
    workspaceId: LOCAL,
    nodeId: node.id,
    title: "Checkout tests",
    content: "The checkout suite runs against the payment sandbox.",
    source: "claude",
  });
  seed.close();
}

async function indexWith(owner: string): Promise<Record<string, unknown>> {
  const path = join(home, "cache", LOCAL, "hook-index.json");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const index = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const stamped = index.intelligence_profiles as { owner?: string } | undefined;
      if (stamped?.owner === owner) return index;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`the hook index never carried ${owner}'s profiles`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function hookSessionStart(sessionId: string): Promise<string> {
  const script = join(home, "bin", "pathrule-hook.js");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(HOOK_SCRIPT, script);
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [script],
      {
        env: {
          ...process.env,
          HOME: home,
          PATHRULE_HOME: home,
          PATHRULE_HOOK_EVENT: "SessionStart",
        },
        timeout: 15_000,
      },
      (error, stdout) => {
        if (error && typeof error.code === "number" && error.code !== 0) reject(error);
        else
          resolve(JSON.parse(stdout.trim() || "{}")?.hookSpecificOutput?.additionalContext ?? "");
      },
    );
    child.stdin!.end(
      JSON.stringify({
        cwd: repo,
        session_id: sessionId,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
  });
}

type GetContextResponse = {
  ok?: boolean;
  intelligence_profiles?: string;
  item_versions?: string[];
};

describe("a native account binds one person across the host turn, get_context and the hook", () => {
  it("delivers the bound person's preferences and profiles everywhere, and the hook recognises them", async () => {
    await localWorkspace();
    let who = "native-a";
    const personal = new Map([
      ["native-a", await storeOf("native-a")],
      ["native-b", await storeOf("native-b")],
    ]);
    const mapping: NativeWorkspaceMapping = {
      localWorkspaceId: LOCAL,
      cloudWorkspaceId: CLOUD,
      localRootPath: repo,
    };
    const account = createNativeAccount({
      provider: {
        resolveBinding: async (m) => ({
          userId: who,
          workspaceId: m.cloudWorkspaceId,
          mapping: m,
          userKnowledgeStore: personal.get(who)!,
          profileSource: profiles(who),
        }),
      },
      mappings: [mapping],
      env: process.env,
    });

    // The host's turn: the local store serves the folder, the native edition binds the person.
    const env = process.env;
    const workspaceStores = new WorkspaceStores(env);
    const edition = account.edition();
    const turn = await compileTurnContext(
      { workspaceRoot: repo, userIntent: INTENT, surface: "chat" },
      {
        ...hostTurnSources(env, workspaceStores, () => edition as never),
        project: {
          loadLearningContext: async () => null as never,
          loadProjectMap: async () => null as never,
          readLearningStamp: async () => "",
          loadKnowledgeGaps: async () => [],
        },
      },
      new TurnContextCache(),
    );
    workspaceStores.closeAll();
    expect(turn.block).not.toContain("## How this person works");
    expect(turn.block).toContain("Run the checkout suite against the sandbox (native-a).");

    // get_context on the local store, with the same person bound.
    installMcpPlugins([
      {
        name: "cloud",
        contract: MCP_PLUGIN_CONTRACT,
        sharedPackages: [],
        personalAccount: account.personalAccount(),
      },
    ]);
    const response = (await getContextTool.handler({
      cwd: repo,
      user_intent: INTENT,
    } as never)) as GetContextResponse;
    expect(response.ok).toBe(true);
    expect(response).not.toHaveProperty("user_guidance");
    expect(response.intelligence_profiles).toBeTruthy();
    expect(turn.block).toContain(response.intelligence_profiles!);
    const profileVersion = intelligenceItemVersion("chat", response.intelligence_profiles!);
    expect(turn.itemVersions).toContain(profileVersion);
    expect(response.item_versions).toEqual([profileVersion]);

    // The hook index get_context wrote is the same person's, and the hook delivers it with no
    // other session anywhere: the native owner is the signed-in one.
    const index = await indexWith("native-a");
    const stamped = index.intelligence_profiles as {
      owner: string;
      block: string;
      version: string;
    };
    expect(stamped.block.length).toBeLessThanOrEqual(HOOK_PROFILE_BLOCK_MAX_CHARS);
    expect(stamped.version).toBe(intelligenceItemVersion("chat", stamped.block));
    expect(index.personal_owner).toBe("native-a");
    expect(JSON.stringify(index.user_preferences)).toContain("Preference of native-a");
    expect(JSON.stringify(index.user_preferences)).not.toContain("Preference of native-b");
    const start = await hookSessionStart("native-session-1");
    expect(start).toContain(stamped.block);

    // Another person signs in to the same provider: the index still holds native-a's block, and the
    // hook stops delivering it the moment the provider binds native-b.
    who = "native-b";
    await account.signOut();
    expect((await account.binding(LOCAL))?.userId).toBe("native-b");
    const after = await hookSessionStart("native-session-2");
    expect(after).not.toContain(stamped.block);
  });
});
