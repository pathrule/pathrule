// SPDX-License-Identifier: Apache-2.0
// The home's facts over a real host in a scratch Pathrule home: counts as the store holds them,
// receipts as the ledger confirms them, and nothing written by reading.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendDeliveryReceipts } from "@pathrule/integrations/native/delivery-ledger.js";
import { startHost, type RunningHost } from "@pathrule/host/host.js";
import { HostSession } from "@pathrule/host/session.js";

import { localRuntimePaths } from "@pathrule/core/storage/paths.js";
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { CapabilityHost, installCapabilityHost } from "../capabilities/host.js";
import { recordFolderChoice } from "@pathrule/core/workspace/folder-mode.js";
import { CLI_SHARED_PACKAGES, installCliPlugins, type CommandPlugin } from "../plugin.js";
import {
  deliverySummary,
  NOT_READ_YET,
  readHomeSnapshot,
  readQuickFacts,
  readStoreFacts,
} from "./snapshot.js";

let dir: string;
let env: NodeJS.ProcessEnv;
let host: RunningHost;
let session: HostSession;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-home-")));
  env = { PATH: "", HOME: join(dir, "user"), PATHRULE_HOME: join(dir, ".pathrule") };
  mkdirSync(env.HOME!, { recursive: true });
  host = await startHost({ env, version: "test host" });
  session = new HostSession({ env });
});

afterEach(async () => {
  installCapabilityHost(null);
  installCliPlugins([]);
  vi.unstubAllGlobals();
  await session.close();
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function project() {
  const folder = join(dir, "project");
  mkdirSync(join(folder, ".git"), { recursive: true });
  const workspace = await session.initWorkspace({ folder, name: "Project" });
  const store = await session.store(workspace.workspaceId);
  const node = await store.ensureNodeForPath(workspace.workspaceId, "/src");
  for (const title of ["Auth flow", "Retry policy"]) {
    await store.writeMemory({
      workspaceId: workspace.workspaceId,
      nodeId: node.id,
      title,
      content: `${title}.`,
    });
  }
  const archived = await store.writeMemory({
    workspaceId: workspace.workspaceId,
    nodeId: node.id,
    title: "Old",
    content: "Old.",
  });
  await store.deleteMemory({ workspaceId: workspace.workspaceId, id: archived.id } as never);
  await store.writeRule({
    workspaceId: workspace.workspaceId,
    nodeId: node.id,
    name: "No console.log",
    content: "Log through the logger.",
    scopeType: "folder",
    priority: "high",
  });
  return { folder, workspaceId: workspace.workspaceId };
}

describe("the home's facts", { timeout: 60_000 }, () => {
  it("knows a folder without a workspace and reads nothing it cannot", async () => {
    const folder = join(dir, "elsewhere");
    mkdirSync(folder);
    const snapshot = await readHomeSnapshot({ cwd: folder, env, session });
    expect(snapshot.workspace.kind).toBe("none");
    expect(snapshot.knowledge).toEqual({
      state: "unavailable",
      reason: "No Pathrule workspace serves this folder yet.",
    });
    expect(snapshot.deliveries.state).toBe("unavailable");
    expect(snapshot.intelligence.mode).toBe("unset");
    expect(snapshot.context.compression.state).toBe("not_measured");
  });

  it("says the workspace could not be read instead of claiming there is none", async () => {
    const broken = {
      resolveLocal: () => {
        throw new Error("NODE_MODULE_VERSION 146. This version of Node.js requires 137.");
      },
    } as unknown as HostSession;
    const snapshot = await readQuickFacts({ cwd: dir, env, session: broken });
    expect(snapshot.workspace).toMatchObject({
      kind: "none",
      problem: expect.stringContaining("NODE_MODULE_VERSION"),
    });
    expect(snapshot.knowledge).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("The workspace could not be read: NODE_MODULE_VERSION"),
    });
  });

  it("paints first from files, with the store's facts still loading", async () => {
    const { folder } = await project();
    const quick = await readQuickFacts({ cwd: join(folder, "src"), env, session });
    expect(quick.workspace).toMatchObject({
      kind: "local",
      name: "project",
      relativePath: "/src",
      isProject: false,
    });
    expect(quick.knowledge.state).toBe("loading");
    expect(quick.agentIr.state).toBe("loading");
    expect(quick.deliveries.state).toBe("loading");
  });

  it("counts what the store holds, active and archived, through the host", async () => {
    const { folder, workspaceId } = await project();
    const snapshot = await readHomeSnapshot({ cwd: folder, env, session });
    expect(snapshot.workspace).toMatchObject({
      kind: "local",
      id: workspaceId,
      name: "Project",
      isProject: true,
    });
    expect(snapshot.knowledge).toMatchObject({
      state: "measured",
      value: {
        memories: { active: 2, archived: 1 },
        rules: { active: 1, archived: 0 },
        skills: { active: 0, archived: 0 },
      },
    });
    expect(snapshot.agentIr).toMatchObject({
      state: "measured",
      value: { approved: 0, proposed: 0 },
    });
    expect(snapshot.signals).toMatchObject({ state: "measured", value: { groups: 0 } });
    expect(snapshot.activity.state).toBe("measured");
    expect(snapshot.deliveries).toMatchObject({
      state: "measured",
      value: { items: 0, sessions: 0, sessionsTotal: 0 },
    });
  });

  it("counts confirmed receipts of each session's current context window only", async () => {
    const { workspaceId } = await project();
    const item = (id: string) => ({
      kind: "memory" as const,
      id,
      hash: `h-${id}`,
      scope: "project" as const,
    });
    const receipt = (id: string, status: "confirmed" | "failed" | "attempted") => ({
      item: item(id),
      provenance: { source: "hook-index" as const },
      status,
    });
    await appendDeliveryReceipts(
      {
        workspaceId,
        sessionId: "s1",
        channel: "hook",
        epoch: 0,
        receipts: [receipt("a", "confirmed"), receipt("b", "confirmed"), receipt("c", "attempted")],
        now: new Date("2026-10-10T10:00:00Z"),
      },
      env,
    );
    // A provider cut what it said it sent: the failure clears the confirmation.
    await appendDeliveryReceipts(
      {
        workspaceId,
        sessionId: "s1",
        channel: "hook",
        epoch: 0,
        receipts: [receipt("b", "failed")],
        now: new Date("2026-10-10T10:01:00Z"),
      },
      env,
    );
    await appendDeliveryReceipts(
      {
        workspaceId,
        sessionId: "s2",
        channel: "mcp",
        epoch: 0,
        receipts: [receipt("a", "confirmed")],
        now: new Date("2026-10-10T11:00:00Z"),
      },
      env,
    );
    const summary = await deliverySummary(workspaceId, env);
    expect(summary).toMatchObject({
      sessions: 2,
      items: 2,
      byChannel: { hook: 1, mcp: 1 },
      byKind: { memory: 2 },
      lastAt: "2026-10-10T11:00:00.000Z",
      sessionsRead: 2,
      sessionsTotal: 2,
    });
    expect((await deliverySummary(workspaceId, env, 1)).sessionsRead).toBe(1);
  });

  it("writes nothing into the Pathrule home by being read", async () => {
    const { folder } = await project();
    const before = readdirSync(env.PATHRULE_HOME!).sort();
    await readHomeSnapshot({ cwd: folder, env, session });
    expect(readdirSync(env.PATHRULE_HOME!).sort()).toEqual(before);
  });

  it("opening reads only a host that already runs, and otherwise waits for the person", async () => {
    const { folder } = await project();
    const quick = await readQuickFacts({ cwd: folder, env, session });
    // A host runs (this test started one): its store facts are read without starting anything.
    const withHost = await readStoreFacts(quick, { cwd: folder, env }, { launch: false });
    expect(withHost.knowledge.state).toBe("measured");
    await session.close();
    await host.stop();
    // No host: nothing is started, and the facts say how to read them.
    const without = await readStoreFacts(quick, { cwd: folder, env }, { launch: false });
    expect(without.knowledge).toEqual({ state: "deferred", reason: NOT_READ_YET });
    expect(without.agentIr.state).toBe("deferred");
    expect(without.deliveries.state).toBe("measured");
    host = await startHost({ env, version: "test host" });
    session = new HostSession({ env });
  });

  it("asks Pathrule Cloud nothing and reaches no network in Local, even with Cloud installed", async () => {
    const asked: string[] = [];
    const cloud = {
      name: "cloud",
      contract: CLI_PLUGIN_CONTRACT,
      sharedPackages: CLI_SHARED_PACKAGES,
      account: {
        commands: {},
        mcpEntry: () => ({ type: "stdio" as const, command: "x", args: [] }),
        afterInstall: async () => {},
        doctorChecks: async () => [],
        doctorNextStep: () => null,
        authorizeSupportBundle: async () => {},
        configUser: async () => (asked.push("configUser"), "u"),
        signedInUser: async () => (asked.push("signedInUser"), "u"),
      },
    } satisfies CommandPlugin;
    installCliPlugins([cloud]);
    const capabilities = new CapabilityHost({ env });
    installCapabilityHost(capabilities);
    await capabilities.readSelection();
    const fetchSpy = vi.fn(async () => {
      throw new Error("no network in Local");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { folder } = await project();
    recordFolderChoice(env, folder, "local", "setup");
    const snapshot = await readHomeSnapshot({ cwd: folder, env, session });
    expect(snapshot.intelligence.mode).toBe("local");
    expect(snapshot.account.applicable).toBe(false);
    expect(asked).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never checks a stored Cloud sign-in on its own: a check may refresh it over the network", async () => {
    let checked = 0;
    installCliPlugins([
      {
        name: "cloud",
        contract: CLI_PLUGIN_CONTRACT,
        sharedPackages: CLI_SHARED_PACKAGES,
        account: {
          commands: {},
          mcpEntry: () => ({ type: "stdio" as const, command: "x", args: [] }),
          afterInstall: async () => {},
          doctorChecks: async () => [],
          doctorNextStep: () => null,
          authorizeSupportBundle: async () => {},
          configUser: async () => "u",
          signedInUser: async () => (checked++, "u"),
        },
      },
    ]);
    // This folder is a Pathrule Cloud folder by its own choice.
    recordFolderChoice(env, dir, "cloud", "setup");
    const capabilities = new CapabilityHost({ env });
    installCapabilityHost(capabilities);
    await capabilities.readSelection();
    const signedOut = await readHomeSnapshot({ cwd: dir, env, session });
    expect(signedOut.account).toMatchObject({ applicable: true, state: "signed_out" });
    // A stored session (a placeholder, no real token): reported as stored, not checked.
    const credentials = localRuntimePaths(env).credentialsFile;
    mkdirSync(join(credentials, ".."), { recursive: true });
    writeFileSync(credentials, JSON.stringify({ "pathrule::test::cli": "placeholder" }));
    const stored = await readHomeSnapshot({ cwd: dir, env, session });
    expect(stored.account).toMatchObject({ applicable: true, state: "session_stored" });
    expect(stored.account.detail).toMatch(/checked only when you ask/);
    expect(checked).toBe(0);
  });
});
