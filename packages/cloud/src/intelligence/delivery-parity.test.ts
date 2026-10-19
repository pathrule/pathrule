// SPDX-License-Identifier: Apache-2.0
// Unified Intelligence delivery: MCP get_context and the hook carry the same User and Team
// Intelligence from the same calls, and a session gets each piece once.
//
// Real code end to end: the get_context tool handler under a Cloud account, the hook index
// writer, and the hook script itself. Only the edges are
// stand-ins: an in-memory store and a profile provider that
// returns one of the ranking fixture's runs (what the server ranked), so no backend is involved.
import { execFile } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryKnowledgeBackend } from "@pathrule/core";
import { clearProjectLearningCache } from "@pathrule/host/context/project-context.js";
import {
  hookIndexProfiles,
  syncHookIndex,
} from "@pathrule/integrations/index-writers/hook-index-writer.js";
import { installMcpPlugins, type McpPlugin } from "@pathrule/mcp/plugin.js";
import { getContextTool } from "@pathrule/mcp/tools/get-context.js";
import { clearIntelligenceSectionMemory } from "@pathrule/mcp/tools/intelligence-sections.js";
import {
  HOOK_PROFILE_BLOCK_MAX_CHARS,
  intelligenceItemVersion,
} from "@pathrule/protocol/intelligence-delivery.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import {
  deliverIntelligenceProfiles,
  type IntelligenceProfileEntry,
  type IntelligenceProfilePayload,
  type IntelligenceProfileSource,
} from "./profile-context.js";

const OWNER = "person-a";
const INTENT = "fix the flaky checkout test";
const HOOK_SCRIPT = join(__dirname, "../../../integrations/src/hook-supervisor/pathrule-hook.js");

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures/profile-payloads.json"), "utf8"),
) as {
  ranking: {
    team_entries: IntelligenceProfileEntry[];
    personal_entries: IntelligenceProfileEntry[];
    runs: Array<{
      surface: string;
      intent: string;
      team_profile: Array<{ id: string; relevance_score: number }>;
      personal_profile: Array<{ id: string; relevance_score: number }>;
    }>;
  };
};

/** The provider: the fixture's chat run, plus one entry a request about releases ranks in. */
function provider(): IntelligenceProfileSource & { calls: string[] } {
  const run = fixtures.ranking.runs.find((r) => r.surface === "chat" && r.intent === "")!;
  const pick = (entries: IntelligenceProfileEntry[], ranked: typeof run.team_profile) =>
    ranked.map(({ id, relevance_score }) => ({
      ...entries.find((entry) => entry.id === id)!,
      relevance_score,
    }));
  const calls: string[] = [];
  return {
    calls,
    async profileContext(input): Promise<IntelligenceProfilePayload> {
      calls.push(input.userIntent);
      const team = pick(fixtures.ranking.team_entries, run.team_profile);
      if (input.userIntent.includes("release")) {
        team.unshift({
          id: "t-release-train",
          category: "release",
          statement: "Ship releases only from a green release train.",
          priority: "high",
          relevance_score: 0.9,
        });
      }
      return {
        enabled: true,
        team_profile: team,
        personal_profile: pick(fixtures.ranking.personal_entries, run.personal_profile),
      };
    },
  };
}

const PREFERENCE = {
  id: "pref-commits",
  line: "- Prefers small reviewed commits.",
  terms: ["commit"],
  always: false,
};

let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-parity-home-")));
  repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  for (const key of ["PATHRULE_HOME", "PATHRULE_LOCAL", "HOME", "PATHRULE_SIGNATURE_MODE"]) {
    saved[key] = process.env[key];
  }
  process.env.PATHRULE_HOME = home;
  process.env.HOME = home;
  process.env.PATHRULE_SIGNATURE_MODE = "off";
  delete process.env.PATHRULE_LOCAL;
  clearProjectLearningCache();
  clearIntelligenceSectionMemory();
});

afterEach(() => {
  installMcpPlugins([]);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function workspace(id: string): Promise<InMemoryKnowledgeBackend> {
  const backend = new InMemoryKnowledgeBackend();
  backend.registerWorkspace({ workspaceId: id, name: "repo", localRootPath: repo });
  const node = await backend.ensureNodeForPath(id, "/");
  await backend.writeMemory({
    workspaceId: id,
    nodeId: node.id,
    title: "Checkout tests",
    content: "The checkout suite runs against the payment sandbox.",
  });
  return backend;
}

/**
 * The account: Cloud's Project knowledge over the stand-in store, and the bound person whose
 * profiles Cloud's own delivery ranks over the stand-in provider.
 */
function account(
  backend: InMemoryKnowledgeBackend,
  source: IntelligenceProfileSource,
  clientId: string,
): McpPlugin {
  return {
    name: "cloud",
    contract: MCP_PLUGIN_CONTRACT,
    sharedPackages: [],
    projectAccount: {
      resolveContext: async () =>
        ({ backend, userId: OWNER, workspaceId: null, clientId }) as never,
    },
    personalAccount: {
      bind: async (workspaceId) => ({
        userId: OWNER,
        userKnowledge: {} as never,
        intelligenceProfiles: (input) =>
          deliverIntelligenceProfiles(source, { ...input, workspaceId, owner: OWNER }),
      }),
    },
  };
}

function signIn(): void {
  // The native sign-in records its owner where the hook looks (core/storage/account-owners.ts).
  writeFileSync(
    join(home, "account-owners.json"),
    JSON.stringify({
      schema_version: 1,
      owners: { native: { user_id: OWNER, updated_at: new Date().toISOString() } },
    }),
  );
}

async function indexWithProfiles(workspaceId: string): Promise<Record<string, unknown>> {
  const path = join(home, "cache", workspaceId, "hook-index.json");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const index = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (index.intelligence_profiles) return index;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error("the hook index never carried the profiles");
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
        else resolve(JSON.parse(stdout.trim())?.hookSpecificOutput?.additionalContext ?? "");
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

describe("one Intelligence delivery for get_context and the hook", () => {
  it("carries the same profiles, with the same versions, on get_context and the hook index", async () => {
    const backend = await workspace("ws-parity-1");
    const source = provider();

    installMcpPlugins([account(backend, source, "windsurf")]);
    const response = (await getContextTool.handler({
      cwd: repo,
      user_intent: INTENT,
    } as never)) as GetContextResponse;
    expect(response.ok).toBe(true);

    // No engine compiles turn guidance (open packages carry no Engine seam since 2026-10-18).
    expect(response).not.toHaveProperty("user_guidance");
    expect(response.intelligence_profiles).toBeTruthy();
    const profileVersion = intelligenceItemVersion("chat", response.intelligence_profiles!);
    expect(response.item_versions).toEqual([profileVersion]);

    // A conversation that holds them is not sent them again.
    const again = (await getContextTool.handler({
      cwd: repo,
      user_intent: INTENT,
      known_item_versions: response.item_versions,
    } as never)) as GetContextResponse;
    expect(again).not.toHaveProperty("user_guidance");
    expect(again).not.toHaveProperty("intelligence_profiles");

    // The hook index written by that get_context carries the session's selection, bounded, and the
    // person's preferences as the open compiler reads their (empty) store.
    const index = await indexWithProfiles("ws-parity-1");
    const stamped = index.intelligence_profiles as {
      owner: string;
      block: string;
      version: string;
    };
    expect(stamped.owner).toBe(OWNER);
    expect(stamped.block.length).toBeLessThanOrEqual(HOOK_PROFILE_BLOCK_MAX_CHARS);
    expect(stamped.version).toBe(intelligenceItemVersion("chat", stamped.block));
    expect(index.user_preferences).toBeUndefined();
    expect(source.calls).toContain("");
  });

  it("gives a hook client each piece once: the hook's session start, then only what the request adds", async () => {
    const workspaceId = "ws-parity-2";
    const backend = await workspace(workspaceId);
    const source = provider();
    signIn();
    // Claude Code with the Pathrule hook installed in this checkout.
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node pathrule-hook.js" }] }],
        },
      }),
    );
    // The index an account writer stamps (get_context's sync and `pathrule sync` make this call).
    await syncHookIndex({
      backend,
      workspaceId,
      workspaceRoot: repo,
      env: process.env,
      refreshEpisodes: false,
      userPreferences: [PREFERENCE],
      intelligenceProfiles: hookIndexProfiles(
        await deliverIntelligenceProfiles(source, {
          owner: OWNER,
          workspaceId,
          userIntent: "",
          surface: "chat",
          maxChars: HOOK_PROFILE_BLOCK_MAX_CHARS,
        }),
      ),
    });
    const stamped = (await indexWithProfiles(workspaceId)).intelligence_profiles as {
      block: string;
    };

    // The hook delivers the block at the session start.
    const start = await hookSessionStart("parity-session");
    expect(start).toContain(stamped.block);

    installMcpPlugins([account(backend, source, "claude-code")]);
    // get_context adds no profile already there.
    const plain = (await getContextTool.handler({
      cwd: repo,
      user_intent: INTENT,
    } as never)) as GetContextResponse;
    expect(plain.ok).toBe(true);
    expect(plain).not.toHaveProperty("user_guidance");
    expect(plain).not.toHaveProperty("intelligence_profiles");
    expect(plain).not.toHaveProperty("item_versions");

    // A request that ranks in an entry the session start did not carry gets that entry alone.
    const release = (await getContextTool.handler({
      cwd: repo,
      user_intent: "prepare the release notes",
    } as never)) as GetContextResponse;
    expect(release.intelligence_profiles).toContain(
      "Ship releases only from a green release train.",
    );
    for (const line of stamped.block.split("\n").filter((l) => l.startsWith("- ["))) {
      expect(release.intelligence_profiles).not.toContain(line);
    }
  });
});
