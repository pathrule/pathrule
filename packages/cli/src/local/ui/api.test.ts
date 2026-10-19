// SPDX-License-Identifier: Apache-2.0
// The Local Console's API end to end: a real host in a scratch Pathrule home, a workspace it
// created, the `pathrule ui` server in front of it, and a browser's calls (session exchange, then
// every route), with no account anywhere.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLocalPrincipal } from "@pathrule/core/backend/local/identity.js";
import { createHostClient } from "@pathrule/host/client.js";
import { startHost, type RunningHost } from "@pathrule/host/host.js";
import { HostSession } from "@pathrule/host/session.js";

import { CLI_VERSION } from "../../cli-version.js";
import {
  createLocalUiApi,
  HISTORY_UNAVAILABLE_REASON,
  LOCAL_CONSOLE_ACTOR,
  SEMANTIC_UNAVAILABLE_REASON,
  TOPIC_NAMES_OFF_REASON,
  workspacePath,
} from "./api.js";
import { HookIndexRefresher, hostHookIndexSync } from "./hook-index.js";
import { startLocalUiServer, type LocalUiServer } from "./server.js";

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

let dir: string;
let env: NodeJS.ProcessEnv;
let host: RunningHost;
let session: HostSession;
let hookIndex: HookIndexRefresher;
let server: LocalUiServer;
/** Every request body and answer of a test, to check that none needs or names an account. */
let traffic: string[];

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const text = JSON.stringify(body);
  traffic.push(text, JSON.stringify(headers));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path,
        headers: {
          origin: server.origin,
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          "content-length": Buffer.byteLength(text),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const answer = Buffer.concat(chunks).toString("utf8");
          traffic.push(answer);
          resolve({ status: res.statusCode ?? 0, text: answer, json: JSON.parse(answer) });
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

async function openSession(): Promise<(route: string, body?: unknown) => Promise<Answer>> {
  const launch = new URL(server.launchUrl()).hash.slice("#launch=".length);
  const exchanged = await post("/api/session", { launchToken: launch });
  expect(exchanged.status).toBe(200);
  const bearer = exchanged.json.sessionToken as string;
  return (route, body = {}) => post(`/api/${route}`, body, { authorization: `Bearer ${bearer}` });
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pathrule-ui-e2e-")));
  env = { PATH: process.env.PATH, PATHRULE_HOME: join(dir, ".pathrule") };
  host = await startHost({ env, version: "test host" });
  session = new HostSession({ env });
  hookIndex = new HookIndexRefresher({ sync: hostHookIndexSync(session, env) });
  traffic = [];
});

afterEach(async () => {
  await server?.close();
  await hookIndex.close();
  await session.close();
  await host.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function project() {
  const folder = join(dir, "project");
  mkdirSync(join(folder, "src", "api"), { recursive: true });
  const workspace = await session.initWorkspace({ folder, name: "Project" });
  const store = await session.store(workspace.workspaceId);
  const node = await store.ensureNodeForPath(workspace.workspaceId, "/src/api");
  const memory = await store.writeMemory({
    workspaceId: workspace.workspaceId,
    nodeId: node.id,
    title: "Auth flow",
    content: "Tokens refresh through the gateway.",
  });
  const rule = await store.writeRule({
    workspaceId: workspace.workspaceId,
    nodeId: node.id,
    name: "No console.log",
    content: "Log through the logger.",
    scopeType: "folder",
    priority: "high",
  });
  const skill = await store.writeSkill({
    workspaceId: workspace.workspaceId,
    nodeId: node.id,
    name: "Deploy",
    content: "Run the deploy script.",
    tags: ["release"],
  });
  return { folder, workspaceId: workspace.workspaceId, store, memory, rule, skill };
}

async function startServer(cwd: string) {
  server = await startLocalUiServer({
    api: createLocalUiApi({ session, env, cwd, cliVersion: CLI_VERSION, hookIndex }),
    assetsDir: null,
  });
}

describe("the Local Console API over a real host", { timeout: 60_000 }, () => {
  it("serves every route of a local workspace, with no account", async () => {
    const { folder, workspaceId, store, memory, rule, skill } = await project();
    await startServer(join(folder, "src"));
    const api = await openSession();

    // runtime.status
    const status = await api("runtime.status");
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      edition: "local",
      account: "none",
      apiVersion: 1,
      cliVersion: CLI_VERSION,
      host: { mode: "client", version: "test host", pid: process.pid, plugins: [] },
      home: env.PATHRULE_HOME,
      currentWorkspaceId: workspaceId,
    });
    const semantic = store.capabilities().semantic;
    expect(status.json.capabilities).toEqual({
      knowledgeRead: { available: true },
      knowledgeWrite: { available: true },
      search: { available: true },
      searchAll: { available: true },
      semanticSearch: semantic
        ? { available: true }
        : { available: false, reason: SEMANTIC_UNAVAILABLE_REASON },
      activity: { available: true },
      runtimeEvents: { available: true },
      deliveryStats: { available: true },
      workspaceSummary: { available: true },
      favorites: { available: true },
      knowledgeTopics: { available: true },
      knowledgeHistory: { available: false, reason: HISTORY_UNAVAILABLE_REASON },
    });

    // deliveries.stats: counted from this machine's session ledgers, once per item per session.
    const ledgers = join(env.PATHRULE_HOME!, "cache", workspaceId, "deliveries");
    mkdirSync(ledgers, { recursive: true });
    const at = new Date().toISOString();
    const receipt = (kind: string, id: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        v: 1,
        type: "receipt",
        at,
        workspace_id: workspaceId,
        session_id: "s1",
        epoch: 0,
        channel: "hook",
        item: { kind, id, hash: "h", scope: "project" },
        provenance: { source: "hook-index" },
        status: "confirmed",
        ...extra,
      });
    writeFileSync(
      join(ledgers, "s1.jsonl"),
      [
        receipt("memory", "m-1"),
        receipt("memory", "m-1", { channel: "mcp" }),
        receipt("rule", "r-1"),
        receipt("protocol", "pathrule-protocol"),
        receipt("skill", "k-1", { status: "failed" }),
      ].join("\n"),
    );
    writeFileSync(join(ledgers, "s2.jsonl"), receipt("memory", "m-1"));
    const stats = await api("deliveries.stats", { workspaceId, days: 7 });
    expect(stats.status).toBe(200);
    expect(stats.json.days).toHaveLength(7);
    expect(stats.json.days[6]).toMatchObject({ memory: 2, rule: 1, skill: 0 });
    expect(stats.json.items).toEqual([
      { kind: "memory", id: "m-1", count: 2, previous: 0 },
      { kind: "rule", id: "r-1", count: 1, previous: 0 },
    ]);
    expect((await api("deliveries.stats", { workspaceId, days: 14 })).status).toBe(400);
    expect((await api("deliveries.stats", { workspaceId: "nope", days: 7 })).status).toBe(404);

    // workspaces.summary: each workspace at a glance, deliveries from the same ledgers.
    const glance = await api("workspaces.summary");
    expect(glance.status).toBe(200);
    expect(glance.json.favorites).toEqual([]);
    expect(glance.json.workspaces).toHaveLength(1);
    const entry = glance.json.workspaces[0];
    expect(entry).toMatchObject({
      id: workspaceId,
      items: { memory: 1, rule: 1, skill: 1 },
      previousDeliveries: 0,
      activeSignals: 0,
    });
    expect(entry.deliveries).toHaveLength(30);
    expect(entry.deliveries[29]).toBe(3);
    // The knowledge written above is the latest activity.
    expect(Date.now() - Date.parse(entry.lastActivityAt)).toBeLessThan(60_000);
    expect((await api("workspaces.summary", { extra: 1 })).status).toBe(400);

    // workspaces.favorite: kept in the Pathrule home, never the browser.
    const favorite = (value: unknown, id: unknown = workspaceId) =>
      api("workspaces.favorite", { workspaceId: id, favorite: value });
    expect((await favorite(true)).json).toEqual({ favorites: [workspaceId] });
    expect((await favorite(true)).json).toEqual({ favorites: [workspaceId] });
    expect(
      JSON.parse(readFileSync(join(env.PATHRULE_HOME!, "console-favorites.json"), "utf8")),
    ).toEqual({ version: 1, workspaces: [workspaceId] });
    expect((await api("workspaces.summary")).json.favorites).toEqual([workspaceId]);
    expect((await favorite(false)).json).toEqual({ favorites: [] });
    expect((await favorite("yes")).status).toBe(400);
    expect((await favorite(true, "nope")).status).toBe(404);

    // workspaces.list
    const listed = await api("workspaces.list");
    expect(listed.json).toEqual({
      workspaces: [{ id: workspaceId, name: "Project", rootPath: folder, current: true }],
    });

    // tree.get
    const tree = await api("tree.get", { workspaceId });
    expect(tree.json.nodes.map((n: { relativePath: string }) => n.relativePath)).toEqual(
      expect.arrayContaining(["/", "/src", "/src/api"]),
    );

    // knowledge.list, each kind
    const memories = await api("knowledge.list", { workspaceId, kind: "memory" });
    expect(memories.json.items).toEqual([
      expect.objectContaining({
        id: memory.id,
        kind: "memory",
        title: "Auth flow",
        preview: "Tokens refresh through the gateway.",
        path: "/src/api",
        paths: ["/src/api"],
        versionNumber: 1,
        // This machine's own user added it; written over the host, so not by an agent.
        createdBy: expect.objectContaining({ name: expect.any(String) }),
        addedVia: expect.stringMatching(/^(agent|person)$/),
      }),
    ]);
    expect(memories.json.items[0].createdBy.name).toBe(memories.json.items[0].createdBy.id);

    // knowledge.topics: grouped on this machine; without a model they carry their words.
    const topics = await api("knowledge.topics", { workspaceId });
    expect(topics.status).toBe(200);
    expect(topics.json).toMatchObject({
      status: expect.stringMatching(/^(ready|computing)$/),
      naming: { status: "off", reason: TOPIC_NAMES_OFF_REASON },
    });
    expect(
      (await api("knowledge.history", { workspaceId, kind: "memory", id: memory.id })).status,
    ).toBe(503);
    const rules = await api("knowledge.list", { workspaceId, kind: "rule" });
    expect(rules.json.items).toEqual([
      expect.objectContaining({
        id: rule.id,
        kind: "rule",
        title: "No console.log",
        path: "/src/api",
        priority: "high",
        scopeType: "folder",
      }),
    ]);
    const skills = await api("knowledge.list", { workspaceId, kind: "skill" });
    expect(skills.json.items).toEqual([
      expect.objectContaining({ id: skill.id, kind: "skill", path: "/src/api", tags: ["release"] }),
    ]);

    // knowledge.read
    const readMemory = await api("knowledge.read", { workspaceId, kind: "memory", id: memory.id });
    expect(readMemory.json.record).toMatchObject({
      kind: "memory",
      path: "/src/api",
      item: { id: memory.id, content: "Tokens refresh through the gateway." },
    });
    const readRule = await api("knowledge.read", { workspaceId, kind: "rule", id: rule.id });
    expect(readRule.json.record).toMatchObject({ kind: "rule", paths: ["/src/api"] });
    const readSkill = await api("knowledge.read", { workspaceId, kind: "skill", id: skill.id });
    expect(readSkill.json.record).toMatchObject({ kind: "skill", paths: ["/src/api"] });
    const missing = await api("knowledge.read", { workspaceId, kind: "memory", id: "nope" });
    expect(missing.json).toEqual({ record: null });

    // knowledge.search
    const found = await api("knowledge.search", { workspaceId, query: "auth" });
    expect(found.json.items).toEqual([
      expect.objectContaining({ id: memory.id, kind: "memory", score: 30 }),
    ]);
    const byPath = await api("knowledge.search", {
      workspaceId,
      query: "src/api",
      kinds: ["rule", "skill"],
    });
    expect(byPath.json.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      "rule",
      "skill",
    ]);
    // A folder keeps a search to what is attached under it; an empty query lists it.
    const inFolder = await api("knowledge.search", { workspaceId, query: "", path: "/src/" });
    expect(inFolder.json.items.map((i: { id: string }) => i.id).sort()).toEqual(
      [memory.id, rule.id, skill.id].sort(),
    );
    expect(
      (await api("knowledge.search", { workspaceId, query: "auth", path: "/docs" })).json,
    ).toEqual({ items: [] });

    // knowledge.searchAll: every local workspace of the home at once, scored as above.
    expect((await api("knowledge.searchAll", { query: "auth" })).json).toEqual({
      items: [
        expect.objectContaining({
          id: memory.id,
          workspaceId,
          workspaceName: "Project",
          score: 30,
        }),
      ],
      truncated: false,
    });
    expect((await api("knowledge.searchAll", { query: "auth", workspaceId })).status).toBe(400);

    // knowledge.create, and the hook index after it
    const created = await api("knowledge.create", {
      workspaceId,
      kind: "memory",
      path: "/src/invoices",
      title: "Invoices are immutable",
      content: "Correct an invoice with a credit note.",
    });
    expect(created.status).toBe(200);
    expect(created.json).toEqual({
      id: expect.any(String),
      versionId: expect.any(String),
      hookIndex: "synced",
    });
    const createdId = created.json.id as string;
    const index = readFileSync(
      join(env.PATHRULE_HOME!, "cache", workspaceId, "hook-index.json"),
      "utf8",
    );
    expect(index).toContain(createdId);
    expect(JSON.parse(index).workspace_root).toBe(folder);
    // Attributed by the host to the local principal; the browser names nobody.
    const stored = await store.readMemory(createdId);
    expect(stored).toMatchObject({ source: "manual", createdBy: resolveLocalPrincipal() });
    expect((await store.findNodeByPath(workspaceId, "/src/invoices"))?.id).toBe(stored?.nodeId);
    const createdRule = await api("knowledge.create", {
      workspaceId,
      kind: "rule",
      path: "/",
      title: "Money is integer cents",
      content: "Never store floats.",
      scopeType: "project",
      priority: "medium",
    });
    expect(createdRule.status).toBe(200);
    // Within the debounce window: folded into one trailing refresh.
    expect(createdRule.json.hookIndex).toBe("scheduled");
    const createdSkill = await api("knowledge.create", {
      workspaceId,
      kind: "skill",
      path: "/src",
      title: "Release notes",
      content: "Write them for people.",
      description: "How release notes read",
    });
    expect(createdSkill.status).toBe(200);
    expect((await store.readSkill(createdSkill.json.id))?.description).toBe(
      "How release notes read",
    );

    // knowledge.update, and a stale version
    const updated = await api("knowledge.update", {
      workspaceId,
      kind: "memory",
      id: createdId,
      expectedVersionId: created.json.versionId,
      content: "Correct an invoice with a credit note, never an edit.",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.versionId).not.toBe(created.json.versionId);
    expect(["synced", "scheduled"]).toContain(updated.json.hookIndex);
    const stale = await api("knowledge.update", {
      workspaceId,
      kind: "memory",
      id: createdId,
      expectedVersionId: created.json.versionId,
      title: "Lost update",
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("conflict");
    expect((await store.readMemory(createdId))?.title).toBe("Invoices are immutable");
    const ruleUpdate = await api("knowledge.update", {
      workspaceId,
      kind: "rule",
      id: rule.id,
      expectedVersionId: rule.versionId,
      priority: "low",
    });
    expect(ruleUpdate.status).toBe(200);
    expect((await store.readRule(rule.id))?.priority).toBe("low");

    // knowledge.delete (soft), a stale delete, then knowledge.restore
    const staleDelete = await api("knowledge.delete", {
      workspaceId,
      kind: "memory",
      id: createdId,
      expectedVersionId: created.json.versionId,
    });
    expect(staleDelete.status).toBe(409);
    const deleted = await api("knowledge.delete", {
      workspaceId,
      kind: "memory",
      id: createdId,
      expectedVersionId: updated.json.versionId,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json).toMatchObject({ id: createdId, versionId: null });
    expect(await store.readMemory(createdId)).toBeNull();
    const archived = await api("knowledge.list", {
      workspaceId,
      kind: "memory",
      status: "archived",
    });
    expect(archived.json.items.map((i: { id: string }) => i.id)).toEqual([createdId]);
    expect(archived.json.items[0].path).toBe("/src/invoices");
    // An archived item is still readable, so the console can show what a restore brings back.
    const readArchived = await api("knowledge.read", {
      workspaceId,
      kind: "memory",
      id: createdId,
    });
    expect(readArchived.json.record.item.id).toBe(createdId);
    expect(readArchived.json.record.path).toBe("/src/invoices");
    const restored = await api("knowledge.restore", { workspaceId, kind: "memory", id: createdId });
    expect(restored.status).toBe(200);
    expect(restored.json.versionId).toBe(updated.json.versionId);
    expect((await store.readMemory(createdId))?.content).toContain("never an edit");
    const again = await api("knowledge.restore", { workspaceId, kind: "memory", id: createdId });
    expect(again.status).toBe(409);
    // A hard delete is not on offer.
    const hard = await api("knowledge.delete", {
      workspaceId,
      kind: "memory",
      id: createdId,
      hard: true,
    });
    expect(hard.status).toBe(400);

    // activity.recent
    await store.logActivity({
      workspaceId,
      nodePath: "/src/api",
      domain: "backend",
      action: "fix",
      scope: "api",
      subjects: ["Auth"],
      taskSummary: "Fixed the token refresh",
      // Shown relative to the workspace's folder; a file outside it is not shown at all.
      filesTouched: {
        total: 3,
        by_area: {
          api: [join(folder, "src", "api", "token.ts"), "./src/api/token.ts", join(dir, "x.ts")],
        },
      },
    });
    const activity = await api("activity.recent", { workspaceId, limit: 500 });
    expect(activity.status).toBe(200);
    expect(activity.json.entries).toEqual([
      expect.objectContaining({
        nodePath: "/src/api",
        domain: "backend",
        action: "fix",
        summary: "Fixed the token refresh",
        scope: "api",
        subjects: ["auth"],
        files: ["src/api/token.ts"],
        client: "claude-code",
        person: null,
      }),
    ]);
    const week = await api("activity.recent", { workspaceId, days: 7 });
    expect(week.json).toEqual({
      entries: [expect.objectContaining({ summary: "Fixed the token refresh" })],
      truncated: false,
    });
    expect((await api("activity.recent", { workspaceId, days: 14 })).status).toBe(400);

    // After the last trailing refresh, the index carries what the store holds.
    await hookIndex.flush();
    const finalIndex = readFileSync(
      join(env.PATHRULE_HOME!, "cache", workspaceId, "hook-index.json"),
      "utf8",
    );
    expect(finalIndex).toContain(createdId);
    expect(finalIndex).toContain(createdRule.json.id);

    // No request needed an account, and no answer names one, beyond saying there is none.
    const everything = traffic.join("\n").replaceAll('"account":"none"', "");
    expect(everything).not.toMatch(/account|log ?in|sign ?in|organization|billing|subscription/i);
  });

  it("refuses a workspace that is not one of the home's local workspaces, mirrors included", async () => {
    const { workspaceId } = await project();
    const hosted = join(dir, "hosted");
    mkdirSync(hosted, { recursive: true });
    const mirror = await session.initWorkspace({ folder: hosted, name: "Hosted" });
    const mirrored = await session.store(mirror.workspaceId);
    await mirrored.writeMemory({
      workspaceId: mirror.workspaceId,
      title: "Auth",
      content: "Hosted.",
    });
    await session.markMirror(mirror.workspaceId);
    await startServer(dir);
    const api = await openSession();

    const listed = await api("workspaces.list");
    expect(listed.json.workspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId]);
    expect(listed.json.workspaces[0].current).toBe(false);
    expect((await api("runtime.status")).json.currentWorkspaceId).toBeNull();

    const before = host.stores.openWorkspaceIds();
    const routes: Array<[string, Record<string, unknown>]> = [
      ["tree.get", {}],
      ["knowledge.list", { kind: "memory" }],
      ["knowledge.search", { query: "auth" }],
      ["knowledge.create", { kind: "memory", path: "/", title: "T", content: "C" }],
      ["activity.recent", {}],
    ];
    for (const id of [mirror.workspaceId, "unknown-workspace", "../escape"]) {
      for (const [route, body] of routes) {
        const answer = await api(route, { workspaceId: id, ...body });
        expect(answer.status, `${route} ${id}`).toBe(404);
        expect(answer.json.error.code).toBe("not_found");
      }
    }
    expect((await api("tree.get", { workspaceId: "" })).status).toBe(400);
    expect((await api("tree.get", {})).status).toBe(400);
    // Nothing was opened for an id the home does not list.
    expect(host.stores.openWorkspaceIds().filter((id) => !before.includes(id))).toEqual([]);
    // A search of every workspace searches the home's local ones only, never a mirror.
    const everywhere = await api("knowledge.searchAll", { query: "auth" });
    expect(everywhere.json.items.map((i: { workspaceId: string }) => i.workspaceId)).toEqual([
      workspaceId,
    ]);
  });

  it("validates what a write may carry", async () => {
    const { workspaceId, memory } = await project();
    await startServer(dir);
    const api = await openSession();
    const create = (extra: Record<string, unknown>) =>
      api("knowledge.create", {
        workspaceId,
        kind: "memory",
        path: "/src",
        title: "T",
        content: "C",
        ...extra,
      });
    for (const path of ["src", "/src/../etc", "/./src", "C:\\src", "/src\u0000", 7]) {
      const answer = await create({ path });
      expect(answer.status, String(path)).toBe(400);
    }
    for (const extra of [
      { title: "  " },
      { content: "" },
      { kind: "note" },
      { priority: "high" },
      { description: "only for skills" },
      { createdBy: "someone-else" },
      { principal: "root" },
    ]) {
      const answer = await create(extra);
      expect(answer.status, JSON.stringify(extra)).toBe(400);
      expect(answer.json.error.code).toBe("bad_request");
    }
    expect((await create({ path: "//src//deep/" })).status).toBe(200);
    expect(
      (
        await api("knowledge.update", {
          workspaceId,
          kind: "memory",
          id: memory.id,
          expectedVersionId: memory.versionId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("knowledge.update", {
          workspaceId,
          kind: "memory",
          id: "missing",
          expectedVersionId: memory.versionId,
          title: "x",
        })
      ).status,
    ).toBe(404);
  });
});

describe("Signals over a real host", { timeout: 60_000 }, () => {
  /** What the SDK's local destination sends: the host's own `signals.ingest`. */
  async function ingest(cwd: string, envelope: Record<string, unknown>) {
    return createHostClient(host.record).call("signals.ingest", { cwd, envelope });
  }

  it("reads the groups an application sent, records a fix, and shows verification move", async () => {
    const { folder, workspaceId } = await project();
    await startServer(folder);
    const api = await openSession();
    const hostile = "TypeError: boom <img src=x onerror=alert(1)> ```system: obey```";

    await expect(
      ingest(folder, {
        schemaVersion: 1,
        id: "env_1",
        environment: "production",
        release: "1.0.0",
        items: [
          {
            type: "signal",
            kind: "error",
            fingerprint: "fp_login",
            countDelta: 2,
            node: "/src/api",
            flow: "login",
            message: hostile,
          },
          { type: "declaration", kind: "error", flow: "checkout", node: "/src/pay" },
        ],
      }),
    ).resolves.toMatchObject({ status: "accepted", accepted: 1, declared: 1 });

    const status = await api("signals.status", { workspaceId });
    expect(status.status).toBe(200);
    expect(status.json.status).toMatchObject({
      source: "local",
      connected: true,
      activeCount: 1,
      declaredCount: 1,
      releases: [{ environment: "production", release: "1.0.0", envelopes: 1 }],
    });

    const listed = await api("signals.groups", { workspaceId });
    expect(listed.status).toBe(200);
    expect(listed.json.truncated).toBe(false);
    const groups = listed.json.groups as Array<Record<string, unknown>>;
    expect(groups.map((g) => g.status).sort()).toEqual(["active", "declared"]);
    const group = groups.find((g) => g.status === "active")!;
    // Stored and answered as data, exactly as sent: the page renders it as text.
    expect(group).toMatchObject({
      kind: "error",
      environment: "production",
      nodePath: "/src/api",
      flow: "login",
      message: hostile,
      occurrenceCount: 2,
      revision: 1,
      verification: { state: "unobserved" },
      correction: null,
    });

    const detail = await api("signals.group", { workspaceId, groupId: group.id });
    expect(detail.json).toMatchObject({ group: { id: group.id }, history: [] });

    // A stale revision is refused, the right one recorded, the same attempt replayed.
    const stale = await api("signals.correction", {
      workspaceId,
      groupId: group.id,
      expectedRevision: 7,
      idempotencyKey: "fix-1",
    });
    expect(stale.json).toMatchObject({ status: "refused", reason: "revision_conflict" });
    const recorded = await api("signals.correction", {
      workspaceId,
      groupId: group.id,
      expectedRevision: 1,
      idempotencyKey: "fix-1",
      note: "Guard the refresh race",
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json).toMatchObject({
      status: "recorded",
      group: {
        status: "active",
        revision: 2,
        verification: { state: "unobserved" },
        correction: {
          attemptId: "fix-1",
          baselineRelease: "1.0.0",
          note: "Guard the refresh race",
          actor: LOCAL_CONSOLE_ACTOR,
        },
      },
    });
    const replay = await api("signals.correction", {
      workspaceId,
      groupId: group.id,
      expectedRevision: 2,
      idempotencyKey: "fix-1",
    });
    expect(replay.json.status).toBe("replayed");

    // A newer release sends: observation starts on it. The fix is not verified by silence alone.
    await ingest(folder, {
      schemaVersion: 1,
      id: "env_2",
      environment: "production",
      release: "1.1.0",
      items: [
        { type: "signal", kind: "event", fingerprint: "fp_ok", countDelta: 1, flow: "login" },
      ],
    });
    const after = await api("signals.group", { workspaceId, groupId: group.id });
    expect(after.json.group.verification).toMatchObject({
      state: "observing",
      candidateRelease: "1.1.0",
    });
    expect(
      (after.json.history as Array<{ event: string; to: string }>).map((h) => [h.event, h.to]),
    ).toEqual([
      ["transition", "observing"],
      ["correction", "unobserved"],
    ]);
  });

  it("validates what a correction may carry and keeps to the home's workspaces", async () => {
    const { folder, workspaceId } = await project();
    await startServer(folder);
    const api = await openSession();
    const base = { workspaceId, groupId: "g1", expectedRevision: 1, idempotencyKey: "k" };
    for (const body of [
      { ...base, groupId: "../x" },
      { ...base, idempotencyKey: "has space" },
      { ...base, expectedRevision: 0 },
      { ...base, note: "x".repeat(501) },
      { ...base, baselineRelease: "r".repeat(121) },
      { ...base, actor: "someone" },
    ]) {
      expect((await api("signals.correction", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api("signals.groups", { workspaceId: "elsewhere" })).status).toBe(404);
    expect((await api("signals.group", { workspaceId, groupId: "missing" })).json).toEqual({
      group: null,
      history: [],
    });
    expect((await api("signals.correction", base)).json).toMatchObject({
      status: "refused",
      reason: "not_found",
    });
  });
});

describe("workspacePath", () => {
  it("keeps a workspace-relative folder path and refuses anything else", () => {
    expect(workspacePath("/")).toBe("/");
    expect(workspacePath("/src//api/")).toBe("/src/api");
    for (const bad of ["", "src", "/..", "/a/../b", "/a/./b", "/a\\b", "/a\nb", null]) {
      expect(() => workspacePath(bad), String(bad)).toThrow();
    }
  });
});
