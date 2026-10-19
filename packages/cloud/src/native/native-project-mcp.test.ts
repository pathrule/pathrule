// SPDX-License-Identifier: Apache-2.0
// The MCP server on a native Project: in local mode, a mapped folder no local store serves is
// served by the provider's `KnowledgeBackend` under its authenticated owner, through the real tool
// handlers. Local first stays (a folder with a local store keeps it), an unmapped folder never
// reaches the account, a signed-out mapping fails out loud instead of writing somewhere else, and
// the hook index get_context writes carries the person's entries under their owner, withheld after
// logout.
//
// The provider is a stand-in for the Cloud service's `resolveCloudNativeBinding`; its Project backend is
// the open in-memory `KnowledgeBackend`, so this proves the composition, not the remote service.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeBackend, LocalBackend } from "@pathrule/core";
import { captureUserPreference } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { createMemoryUserKnowledgeStore } from "@pathrule/core/user-knowledge/user-knowledge-persistence.js";
import { resetLocalBackends } from "@pathrule/mcp/local-runtime.js";
import { installMcpPlugins } from "@pathrule/mcp/plugin.js";
import { getContextTool } from "@pathrule/mcp/tools/get-context.js";
import { setProjectLearningBudgetForTest } from "@pathrule/mcp/tools/get-context-learning.js";
import { clearIntelligenceSectionMemory } from "@pathrule/mcp/tools/intelligence-sections.js";
import { listMemoriesTool } from "@pathrule/mcp/tools/list-memories.js";
import { resolveTool } from "@pathrule/mcp/tools/resolve.js";
import { writeMemoryTool } from "@pathrule/mcp/tools/write-memory.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import {
  createNativeAccount,
  type NativeAccountBinding,
  type NativeWorkspaceMapping,
} from "./account.js";
import { clearNativeSession, writeNativeSession } from "./credentials.js";

const LOCAL_ID = "ws-native-local";
// get_context syncs a remote workspace's hook index once per process, so each case gets its own.
let CLOUD_ID = "";
let caseNo = 0;
const HOOK_SCRIPT = join(__dirname, "../../../integrations/src/hook-supervisor/pathrule-hook.js");

let home: string;
let repo: string;
let elsewhere: string;
const saved: Record<string, string | undefined> = {};
const prevCwd = process.cwd();

beforeEach(() => {
  CLOUD_ID = `native-cloud-project-${++caseNo}`;
  home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-native-mcp-")));
  repo = join(home, "repo");
  elsewhere = join(home, "elsewhere");
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  for (const key of [
    "PATHRULE_HOME",
    "PATHRULE_LOCAL",
    "PATHRULE_LOCAL_PRINCIPAL",
    "HOME",
    "PATHRULE_SIGNATURE_MODE",
  ])
    saved[key] = process.env[key];
  Object.assign(process.env, {
    PATHRULE_HOME: home,
    HOME: home,
    PATHRULE_LOCAL: "1",
    PATHRULE_LOCAL_PRINCIPAL: "local-person",
    PATHRULE_SIGNATURE_MODE: "off",
  });
  setProjectLearningBudgetForTest(30_000);
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
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The provider's Project: an authorized cloud workspace whose checkout is `repo`. */
async function project(): Promise<InMemoryKnowledgeBackend> {
  const backend = new InMemoryKnowledgeBackend();
  backend.registerWorkspace({ workspaceId: CLOUD_ID, name: "project", localRootPath: repo });
  const root = await backend.ensureNodeForPath(CLOUD_ID, "/");
  await backend.writeMemory({
    workspaceId: CLOUD_ID,
    nodeId: root.id,
    title: "Checkout tests",
    content: "PROJECT_MEMORY the checkout suite runs against the sandbox.",
  });
  await backend.writeRule({
    workspaceId: CLOUD_ID,
    nodeId: root.id,
    name: "PROJECT_RULE never call the live payment API",
    content: "Use the sandbox keys only.",
    scopeType: "project",
    priority: "high",
  });
  await backend.writeSkill({
    workspaceId: CLOUD_ID,
    nodeId: root.id,
    name: "release-checklist",
    content:
      "---\nname: release-checklist\ndescription: PROJECT_SKILL steps\n---\n1. Run the gate.",
  });
  return backend;
}

/**
 * The bound person's own store, holding one lasting habit they stated in this Project: the open
 * compiler turns it into the preference line the hook index carries for them.
 */
async function personStore(userId: string) {
  const store = createMemoryUserKnowledgeStore();
  const words = `A habit of mine: run the checkout suite twice before a push, PREF_OF_${userId}.`;
  const captured = await captureUserPreference(
    store,
    {
      kind: "procedure",
      claim: `Run the checkout suite twice before a push (PREF_OF_${userId}).`,
      quotes: [`run the checkout suite twice before a push, PREF_OF_${userId}`],
      lasting: true,
    },
    {
      workspaceId: CLOUD_ID,
      words: [{ sid: "s0", at: "2026-10-15T00:00:00.000Z", text: words }],
      now: "2026-10-15T00:00:00.000Z",
    },
  );
  expect(captured).toMatchObject({ ok: true, status: "active" });
  return store;
}

async function compose(backend: InMemoryKnowledgeBackend) {
  const stores = new Map([["native-a", await personStore("native-a")]]);
  let who: string | null = "native-a";
  const mapping: NativeWorkspaceMapping = {
    localWorkspaceId: LOCAL_ID,
    cloudWorkspaceId: CLOUD_ID,
    localRootPath: repo,
  };
  const resolveBinding = vi.fn(
    async (m: NativeWorkspaceMapping): Promise<NativeAccountBinding | null> =>
      who === null
        ? null
        : {
            userId: who,
            workspaceId: m.cloudWorkspaceId,
            mapping: m,
            userKnowledgeStore: stores.get(who) ?? createMemoryUserKnowledgeStore(),
            profileSource: { profileContext: async () => null },
            knowledge: backend,
          },
  );
  const account = createNativeAccount({
    provider: { resolveBinding },
    mappings: [mapping],
    env: process.env,
    serveProjectBackend: true,
  });
  installMcpPlugins([
    {
      name: "cloud",
      contract: MCP_PLUGIN_CONTRACT,
      sharedPackages: [],
      personalAccount: account.personalAccount(),
      projectAccount: account.projectAccount()!,
    },
  ]);
  return { account, resolveBinding, signInAs: (id: string | null) => void (who = id) };
}

type Response = {
  ok?: boolean;
  error?: { code?: string; message?: string };
} & Record<string, unknown>;

async function indexWithOwner(): Promise<Record<string, unknown>> {
  const path = join(home, "cache", CLOUD_ID, "hook-index.json");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const index = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (index.personal_owner) return index;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error("get_context never wrote the Project's hook index");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function hookPrompt(session: string): Promise<string> {
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
          PATHRULE_HOOK_EVENT: "UserPromptSubmit",
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
        session_id: session,
        hook_event_name: "UserPromptSubmit",
        prompt: "fix the checkout test",
      }),
    );
  });
}

describe("MCP on a native Project", () => {
  it(
    "serves get_context and the knowledge tools from the provider's backend, under its owner",
    { timeout: 30_000 },
    async () => {
      const backend = await project();
      const { resolveBinding } = await compose(backend);
      process.chdir(repo);

      const context = (await getContextTool.handler({
        cwd: repo,
        user_intent: "fix the checkout test",
      } as never)) as Response;
      expect(context.ok).toBe(true);
      const text = JSON.stringify(context);
      expect(text).toContain("PROJECT_MEMORY");
      expect(context.workspace_id).toBe(CLOUD_ID);
      // No engine compiles turn guidance: the person's entries reach the hook, not get_context.
      expect(context).not.toHaveProperty("user_guidance");
      // Rules and skills are the Project's too, through the same resolution.
      const rule = JSON.stringify(
        await resolveTool.handler({ query: "PROJECT_RULE", kind: "rule", cwd: repo } as never),
      );
      expect(rule).toContain("PROJECT_RULE never call the live payment API");
      const skill = JSON.stringify(
        await resolveTool.handler({
          query: "release-checklist",
          kind: "skill",
          cwd: repo,
        } as never),
      );
      expect(skill).toContain("PROJECT_SKILL");
      // The hook index get_context wrote carries the Project's rule for the hook.
      expect(JSON.stringify(await indexWithOwner())).toContain(
        (await backend.listRules({ workspaceId: CLOUD_ID }))[0]!.id,
      );
      expect(resolveBinding).toHaveBeenCalled();

      const written = (await writeMemoryTool.handler({
        cwd: repo,
        node_path: "/",
        title: "Sandbox keys rotate",
        content: "Rotate the sandbox keys monthly.",
      } as never)) as Response;
      expect(written.ok).toBe(true);
      const listed = await backend.listMemories({ workspaceId: CLOUD_ID });
      expect(listed.map((m) => m.title)).toContain("Sandbox keys rotate");
      const root = await backend.findNodeByPath(CLOUD_ID, "/");
      expect(
        JSON.stringify(await listMemoriesTool.handler({ node_id: root!.id } as never)),
      ).toContain("Sandbox keys rotate");
      // The write made the hook index stale (an account's index is written once per process): the
      // next get_context rewrites it, so the hook delivers what the store now holds.
      await getContextTool.handler({ cwd: repo, user_intent: "rotate the sandbox keys" } as never);
      const indexPath = join(home, "cache", CLOUD_ID, "hook-index.json");
      const deadline = Date.now() + 10_000;
      while (!readFileSync(indexPath, "utf8").includes("Sandbox keys rotate")) {
        if (Date.now() > deadline) throw new Error("the hook index never picked up the write");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Nothing was written to a local store under either id.
      expect(LocalBackend.discoverWorkspaceForCwd(repo, process.env)).toBeNull();
    },
  );

  it("keeps a folder a local store serves local, and never sends an unmapped folder to the account", async () => {
    const backend = await project();
    const { resolveBinding } = await compose(backend);
    const UNMAPPED = "ws-unmapped-local";
    const seed = LocalBackend.openForWorkspace(UNMAPPED, process.env);
    seed.registerWorkspace({ workspaceId: UNMAPPED, name: "local", localRootPath: elsewhere });
    const node = await seed.ensureNodeForPath(UNMAPPED, "/");
    await seed.writeMemory({
      workspaceId: UNMAPPED,
      nodeId: node.id,
      title: "LOCAL_ONLY note",
      content: "Local knowledge.",
      source: "claude",
    });
    seed.close();
    await resetLocalBackends();

    process.chdir(elsewhere);
    const local = JSON.stringify(
      await getContextTool.handler({ cwd: elsewhere, user_intent: "note" } as never),
    );
    expect(local).toContain("LOCAL_ONLY");
    expect(local).not.toContain("PROJECT_MEMORY");
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("fails out loud when the mapped Project's session is gone, and the hook withholds the person's entries after logout", async () => {
    const backend = await project();
    const { signInAs } = await compose(backend);
    await writeNativeSession(
      {
        base_url: "https://native.example.test",
        user_id: "native-a",
        token: "tok",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      { env: process.env },
    );
    process.chdir(repo);

    expect(
      (
        (await getContextTool.handler({
          cwd: repo,
          user_intent: "fix the checkout test",
        } as never)) as Response
      ).ok,
    ).toBe(true);
    const index = await indexWithOwner();
    expect(index.personal_owner).toBe("native-a");
    expect(await hookPrompt("s-signed-in")).toContain("PREF_OF_native-a");

    // Logout: the session file, the owner record and the person's private entries go.
    await clearNativeSession({ env: process.env });
    expect(await hookPrompt("s-logged-out")).not.toContain("PREF_OF_native-a");
    expect(
      JSON.parse(readFileSync(join(home, "cache", CLOUD_ID, "hook-index.json"), "utf8")),
    ).not.toHaveProperty("user_preferences");

    signInAs(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const gone = (await createNativeAccount({
      provider: { resolveBinding: async () => null },
      mappings: [{ localWorkspaceId: LOCAL_ID, cloudWorkspaceId: CLOUD_ID, localRootPath: repo }],
      env: process.env,
      serveProjectBackend: true,
    })
      .projectAccount()!
      .resolveContext({ workspaceId: null, cwd: repo })
      .catch((err: Error) => err.message)) as string;
    expect(gone).toMatch(/no native session can serve it/);
  }, 30_000);
});
