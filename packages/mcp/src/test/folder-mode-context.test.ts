// SPDX-License-Identifier: Apache-2.0
// One edition per folder, as the MCP server serves it (core workspace/folder-mode.ts):
//
// - a folder whose choice is Pathrule Cloud is served by the Project account and by nothing else: with
//   no Cloud plugin the call fails, even with a real Local store on the same folder;
// - a folder with a Local workspace and a Cloud attachment and no choice fails until the person chooses;
// - a Local folder is served from its store, and an explicit Cloud workspace id there fails;
// - nothing creates `<home>/<cloud workspace id>/pathrule.db`: not a context, not the hook-index sync,
//   not the rules render, not the learning drains, which write a Cloud folder's lessons through its
//   Project backend instead.
//
// Every case runs the real functions on a temporary Pathrule home; the Project account is a stand-in
// whose backend is the open in-memory `KnowledgeBackend`.
import { removeScratch } from "./scratch.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeBackend, LocalBackend } from "@pathrule/core";
import { ENDED_TURNS_LEDGER } from "@pathrule/core/maintenance/turn-lessons.js";
import type { ToolContext } from "@pathrule/core/tools/types.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { runWithCallCwd } from "../lib/call-cwd.js";
import { renderLocalClaudeRules, syncWorkspaceHookIndex } from "../lib/workspace-hook-index.js";
import {
  getLocalBackend,
  isProjectContext,
  resetLocalBackends,
  resolveOpenContext,
} from "../local-runtime.js";
import { installMcpPlugins } from "../plugin.js";
import { getContextTool } from "../tools/get-context.js";

const LOCAL_ID = "ws-folder-mode-local";
const CLOUD_ID = "ws-folder-mode-cloud";

let home: string;
let repo: string;
let elsewhere: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["PATHRULE_HOME", "HOME", "PATHRULE_LOCAL_PRINCIPAL", "PATHRULE_SIGNATURE_MODE"];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-folder-mode-")));
  repo = join(home, "repo");
  elsewhere = join(home, "elsewhere");
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  Object.assign(process.env, {
    PATHRULE_HOME: home,
    HOME: home,
    PATHRULE_LOCAL_PRINCIPAL: "local-person",
    PATHRULE_SIGNATURE_MODE: "off",
  });
});

afterEach(async () => {
  installMcpPlugins([]);
  await resetLocalBackends();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeScratch(home);
});

/** A call made from `cwd`, as the server runs every tool call. */
const at = <T>(cwd: string, run: () => Promise<T>): Promise<T> => runWithCallCwd({ cwd }, run);

/** A real Local store for `root`, holding one memory only it has ("Local note"). */
async function localStore(root: string): Promise<void> {
  const store = LocalBackend.openForWorkspace(LOCAL_ID, process.env);
  try {
    store.registerWorkspace({ workspaceId: LOCAL_ID, name: "Local project", localRootPath: root });
    const node = await store.ensureNodeForPath(LOCAL_ID, "/");
    await store.writeMemory({
      workspaceId: LOCAL_ID,
      nodeId: node.id,
      title: "Local note",
      content: "LOCAL_ONLY knowledge.",
      source: "claude",
    });
  } finally {
    store.close();
  }
}

/** `root` attached to the Cloud workspace on this machine, as the Cloud plugin records it. */
function attachCloud(root: string): void {
  const dir = join(home, "config", "users", "person-hash");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "native-workspaces.json"),
    JSON.stringify({
      schema_version: 1,
      workspaces: [
        { workspace_id: CLOUD_ID, organization_id: "org-1", name: "Cloud project", root },
      ],
    }),
  );
}

/** The Project's knowledge, as the Cloud serves it ("Cloud note"). */
async function cloudBackend(): Promise<InMemoryKnowledgeBackend> {
  const backend = new InMemoryKnowledgeBackend();
  backend.registerWorkspace({ workspaceId: CLOUD_ID, name: "Cloud project", localRootPath: repo });
  const node = await backend.ensureNodeForPath(CLOUD_ID, "/");
  await backend.writeMemory({
    workspaceId: CLOUD_ID,
    nodeId: node.id,
    title: "Cloud note",
    content: "CLOUD_MEMORY knowledge.",
  });
  return backend;
}

/** A stand-in Project account: `serve` answers its `resolveContext`. */
function installProject(
  serve: (input: { workspaceId: string | null; cwd: string }) => Promise<ToolContext | null>,
) {
  const resolveContext = vi.fn(serve);
  installMcpPlugins([
    {
      name: "cloud",
      contract: MCP_PLUGIN_CONTRACT,
      sharedPackages: [],
      projectAccount: { resolveContext },
    },
  ]);
  return resolveContext;
}

const cloudStoreCreated = () => existsSync(join(home, CLOUD_ID));

describe("a folder whose choice is Pathrule Cloud, with a real Local store on it", () => {
  beforeEach(async () => {
    await localStore(repo);
    attachCloud(repo);
    recordFolderChoice(process.env, repo, "cloud", "setup");
  });

  it("fails with no Cloud plugin: the Local store serves nothing and no store is created", async () => {
    for (const id of [null, LOCAL_ID, CLOUD_ID]) {
      await expect(at(repo, () => resolveOpenContext(id))).rejects.toThrow(
        /uses Pathrule Cloud.*cannot reach Pathrule Cloud.*Nothing is served from a Pathrule Local store.*pathrule setup --cloud.*pathrule doctor/s,
      );
    }
    const answer = JSON.stringify(
      await at(repo, () => getContextTool.handler({ cwd: repo, user_intent: "the note" } as never)),
    );
    expect(answer).toContain('"ok":false');
    expect(answer).toContain("cannot reach Pathrule Cloud");
    expect(answer).not.toContain("Local note");
    expect(cloudStoreCreated()).toBe(false);
  });

  it("is served by the Project account, never by the Local store", async () => {
    const backend = await cloudBackend();
    const resolveContext = installProject(async () => ({
      backend,
      userId: "cloud-person",
      workspaceId: CLOUD_ID,
    }));

    const ctx = await at(repo, () => resolveOpenContext());
    expect(isProjectContext(ctx)).toBe(true);
    expect(ctx.workspaceId).toBe(CLOUD_ID);
    expect(resolveContext).toHaveBeenCalledWith({ workspaceId: null, cwd: repo });

    const answer = JSON.stringify(
      await at(repo, () => getContextTool.handler({ cwd: repo, user_intent: "the note" } as never)),
    );
    expect(answer).toContain("Cloud note");
    expect(answer).not.toContain("Local note");
    // get_context writes the Project's hook index in the background: wait for it, then look.
    const index = join(home, "cache", CLOUD_ID, "hook-index.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(index)) {
      if (Date.now() > deadline)
        throw new Error("get_context never wrote the Project's hook index");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(JSON.parse(readFileSync(index, "utf8"))).toMatchObject({
      workspace_id: CLOUD_ID,
      mode: "cloud",
    });
    expect(cloudStoreCreated()).toBe(false);
  });

  it("names `pathrule login` when no signed-in account serves it, and lets the account's own error through", async () => {
    installProject(async () => null);
    await expect(at(repo, () => resolveOpenContext())).rejects.toThrow(
      /pathrule login.*pathrule setup --cloud/s,
    );
    await expect(at(repo, () => resolveOpenContext())).rejects.toMatchObject({
      code: "auth_required",
    });

    installProject(async () => {
      throw new Error("the Pathrule Cloud session expired");
    });
    await expect(at(repo, () => resolveOpenContext())).rejects.toThrow(
      "the Pathrule Cloud session expired",
    );
    expect(cloudStoreCreated()).toBe(false);
  });
});

describe("a folder with a Local workspace and a Cloud attachment and no choice", () => {
  it("is a conflict, with or without the Cloud plugin, until the person chooses", async () => {
    await localStore(repo);
    attachCloud(repo);
    const conflict =
      /both a Pathrule Local workspace and a Pathrule Cloud workspace.*pathrule setup --cloud.*pathrule setup --local/s;
    await expect(at(repo, () => resolveOpenContext())).rejects.toThrow(conflict);
    await expect(at(repo, () => resolveOpenContext())).rejects.toMatchObject({ code: "conflict" });

    const resolveContext = installProject(async () => ({
      backend: await cloudBackend(),
      userId: "cloud-person",
      workspaceId: CLOUD_ID,
    }));
    await expect(at(repo, () => resolveOpenContext())).rejects.toThrow(conflict);
    expect(resolveContext).not.toHaveBeenCalled();

    recordFolderChoice(process.env, repo, "local", "setup");
    expect((await at(repo, () => resolveOpenContext())).workspaceId).toBe(LOCAL_ID);
  });
});

describe("a Local folder", () => {
  it("is served from its Local store, even with a Project account installed", async () => {
    await localStore(repo);
    const resolveContext = installProject(async () => ({
      backend: await cloudBackend(),
      userId: "cloud-person",
      workspaceId: CLOUD_ID,
    }));

    const ctx = await at(repo, () => resolveOpenContext());
    expect(ctx.workspaceId).toBe(LOCAL_ID);
    expect(isProjectContext(ctx)).toBe(false);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        await at(repo, () =>
          getContextTool.handler({ cwd: repo, user_intent: "the note" } as never),
        ),
      ),
    ).toContain("Local note");
  });

  it("refuses an explicit Cloud workspace id, or one with no store, and creates no store for either", async () => {
    await localStore(repo);
    attachCloud(elsewhere);

    await expect(at(repo, () => resolveOpenContext(CLOUD_ID))).rejects.toThrow(
      /ws-folder-mode-cloud is a Pathrule Cloud workspace.*uses Pathrule Local: call without workspace_id/s,
    );
    await expect(at(repo, () => resolveOpenContext(CLOUD_ID))).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(at(repo, () => resolveOpenContext("ws-never-created"))).rejects.toThrow(
      /No Pathrule Local workspace ws-never-created/,
    );
    await expect(at(repo, () => resolveOpenContext("ws-never-created"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getLocalBackend(CLOUD_ID)).rejects.toThrow(/never from a Pathrule Local store/);
    await expect(getLocalBackend("ws-never-created")).rejects.toThrow(/pathrule init --local/);
    expect(cloudStoreCreated()).toBe(false);
    expect(existsSync(join(home, "ws-never-created"))).toBe(false);
    // The folder's own workspace is still served, and an explicit id naming it is accepted.
    expect((await at(repo, () => resolveOpenContext(LOCAL_ID))).workspaceId).toBe(LOCAL_ID);
  });
});

// The leak chain this closes: a Cloud context's hook-index sync and rules render each opened a store
// under the Cloud workspace's id (for a name, and for local atoms), which the host creates on first
// open, and that store then held Cloud knowledge as if it were a Local workspace.
describe("a Cloud context's hook-index sync and rules render", () => {
  it("create no Local store under the Cloud id, and the turn's command lessons reach the Project", async () => {
    const backend = await cloudBackend();
    attachCloud(repo);
    installProject(async () => ({ backend, userId: "cloud-person", workspaceId: CLOUD_ID }));
    mkdirSync(join(repo, ".claude", "rules", "pathrule"), { recursive: true });
    // A turn whose own commands taught a lesson, as the hook records an ended turn for the drain.
    const cache = join(home, "cache", CLOUD_ID);
    mkdirSync(cache, { recursive: true });
    const transcript = join(home, "session.jsonl");
    const step = (id: string, command: string, out: string) => [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] },
      }),
    ];
    writeFileSync(
      transcript,
      [
        ...step(
          "t1",
          "go test ./acmetest | tail",
          "ok  \tgithub.com/acme/gin\t1.6s\npanic: team environment not prepared\n\ngoroutine 1 [running]:",
        ),
        ...step("t2", "ACME_TEAM_SUITE=1 go test ./acmetest", "ok  acmetest 0.2s"),
      ].join("\n"),
    );
    writeFileSync(
      join(cache, ENDED_TURNS_LEDGER),
      `${JSON.stringify({ sid: "s1", transcript })}\n`,
    );

    const ctx = await at(repo, () => resolveOpenContext());
    expect(isProjectContext(ctx)).toBe(true);
    await syncWorkspaceHookIndex({ ctx, workspaceId: CLOUD_ID, localRootPath: repo });
    await renderLocalClaudeRules(ctx.backend!, CLOUD_ID, repo);

    expect(cloudStoreCreated()).toBe(false);
    expect(JSON.parse(readFileSync(join(cache, "hook-index.json"), "utf8"))).toMatchObject({
      workspace_id: CLOUD_ID,
      mode: "cloud",
    });
    const titles = (await backend.listMemories({ workspaceId: CLOUD_ID })).map((m) => m.title);
    expect(titles).toContain("How to run go test ./acmetest");
    expect(existsSync(join(cache, ENDED_TURNS_LEDGER))).toBe(false);
  });
});
