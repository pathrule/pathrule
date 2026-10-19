// SPDX-License-Identifier: Apache-2.0
// A surface's host session in each of its modes: a host it runs itself, a running host it uses, one
// it launches, a launch that fails, a host it cannot use, a host that goes away mid-session, and
// another surface claiming the home first.
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOST_RPC_VERSION } from "@pathrule/protocol/host-rpc.js";

import { scratchHome, waitFor, type ScratchHome } from "./__fixtures__/helpers.js";
import { hostRecordFile, processAlive, readHostRecord } from "./discovery.js";
import { startHost, type RunningHost } from "./host.js";
import type { HostLaunchCommand } from "./launch.js";
import { HostSession } from "./session.js";
import { HOST_STORE_CALLABLE } from "./store-methods.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/run-host.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs"),
).href;
/** The fixture host. */
const LAUNCH: HostLaunchCommand = {
  command: process.execPath,
  args: ["--import", TSX_LOADER, FIXTURE],
  env: {},
};

let home: ScratchHome;
const sessions: HostSession[] = [];
const hosts: RunningHost[] = [];
const servers: Server[] = [];

function session(options: ConstructorParameters<typeof HostSession>[0] = {}): HostSession {
  const created = new HostSession({ env: home.env, ...options });
  sessions.push(created);
  return created;
}

beforeEach(() => {
  home = scratchHome();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
  for (const server of servers.splice(0)) server.close();
  const record = await readHostRecord(home.env);
  if (record && record.pid !== process.pid && processAlive(record.pid)) {
    process.kill(record.pid, "SIGKILL");
  }
  home.remove();
});

/** Creates a workspace through the session and writes one memory into its store. */
async function workspaceWithMemory(s: HostSession) {
  const folder = join(home.dir, "project");
  mkdirSync(folder, { recursive: true });
  const workspace = await s.initWorkspace({ folder, name: "Project" });
  const store = await s.store(workspace.workspaceId);
  const memory = await store.writeMemory({
    workspaceId: workspace.workspaceId,
    title: "A fact",
    content: "Kept by the host.",
  });
  return { folder, workspace, store, memory };
}

describe("a host session", { timeout: 60_000 }, () => {
  it("runs the host in this process when none runs and none can be launched", async () => {
    const s = session({ version: "test 1" });
    const { workspace, store, memory } = await workspaceWithMemory(s);
    expect(await s.mode()).toBe("own");
    expect((await readHostRecord(home.env))?.pid).toBe(process.pid);
    expect((await store.readMemory(memory.id))?.content).toBe("Kept by the host.");
    // The synchronous store methods answer here too, awaited.
    expect(await store.getWorkspaceName(workspace.workspaceId)).toBe("Project");
    expect(s.resolveLocal(join(home.dir, "project", "src"))?.workspaceId).toBe(
      workspace.workspaceId,
    );
    await s.close();
    expect(await readHostRecord(home.env)).toBeNull();
  });

  it("uses a running host's stores over the RPC, its synchronous methods included", async () => {
    const running = await startHost({ env: home.env });
    hosts.push(running);
    const s = session();
    const { workspace, memory } = await workspaceWithMemory(s);
    expect(await s.mode()).toBe("client");
    // The host owns the store this session wrote through.
    const owned = running.stores.get(workspace.workspaceId);
    expect((await owned.readMemory(memory.id))?.title).toBe("A fact");
    const store = await s.store(workspace.workspaceId);
    await store.registerWorkspace({
      workspaceId: workspace.workspaceId,
      name: "Renamed",
      localRootPath: join(home.dir, "project"),
    });
    expect(await store.getWorkspaceName(workspace.workspaceId)).toBe("Renamed");
    expect(await store.contextsForHookIndex(workspace.workspaceId)).toEqual([]);
    expect(await store.rationalesForHookIndex(workspace.workspaceId)).toEqual([]);
    await s.markMirror(workspace.workspaceId);
    expect(s.resolveLocal(join(home.dir, "project"))).toBeNull();
    expect(s.resolveLocal(join(home.dir, "project"), { includeMirrors: true })?.mirror).toBe(true);
    await s.close();
    // Closing a client leaves the host it used running.
    expect((await readHostRecord(home.env))?.instance_id).toBe(running.record.instance_id);
  });

  it("launches a host of its own that outlives the session", async () => {
    const s = session({ launch: LAUNCH });
    const { memory, store } = await workspaceWithMemory(s);
    expect(await s.mode()).toBe("client");
    const record = (await readHostRecord(home.env))!;
    expect(record.pid).not.toBe(process.pid);
    expect(record.standalone).toBe(true);
    expect((await store.readMemory(memory.id))?.id).toBe(memory.id);
    await s.close();
    expect(processAlive(record.pid)).toBe(true);
  });

  it("runs the host here when the launch fails", async () => {
    const lines: string[] = [];
    const s = session({
      launch: { ...LAUNCH, env: { HOST_FIXTURE_FAIL: "broken install" } },
      log: (line) => lines.push(line),
    });
    expect(await s.mode()).toBe("own");
    expect(lines.join("\n")).toContain("could not launch the host (the host exited with code 1)");
  });

  it("starts over once when its host goes away, on a newly launched one", async () => {
    const s = session({ launch: LAUNCH });
    const { memory, store } = await workspaceWithMemory(s);
    const first = (await readHostRecord(home.env))!;
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => (processAlive(first.pid) ? undefined : true));
    expect((await store.readMemory(memory.id))?.content).toBe("Kept by the host.");
    const second = (await readHostRecord(home.env))!;
    expect(second.instance_id).not.toBe(first.instance_id);
    expect(processAlive(second.pid)).toBe(true);
  });

  it("uses the host another surface claimed first", async () => {
    let other: RunningHost | undefined;
    const s = session({
      // Called just before this session starts its own host: another surface wins the home.
      plugins: async () => {
        other = await startHost({ env: home.env });
        hosts.push(other);
        return [];
      },
    });
    expect(await s.mode()).toBe("client");
    expect((await readHostRecord(home.env))?.instance_id).toBe(other!.record.instance_id);
  });

  it("opens the stores itself beside a host of another RPC version", async () => {
    mkdirSync(dirname(hostRecordFile(home.env)), { recursive: true });
    writeFileSync(
      hostRecordFile(home.env),
      JSON.stringify({
        schema_version: 1,
        rpc: HOST_RPC_VERSION + 1,
        pid: process.pid,
        port: 1,
        token: "t",
        version: "future",
        instance_id: "future",
        started_at: new Date().toISOString(),
      }),
    );
    const lines: string[] = [];
    const s = session({ log: (line) => lines.push(line) });
    const { memory, store } = await workspaceWithMemory(s);
    expect(await s.mode()).toBe("degraded");
    expect(lines.join("\n")).toContain("no usable host");
    expect((await store.readMemory(memory.id))?.title).toBe("A fact");
  });

  it("opens the stores itself beside a host that lacks a store method it calls", async () => {
    // An older release's host: it answers the handshake without the methods this session calls.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          v: HOST_RPC_VERSION,
          id: 1,
          ok: true,
          result: {
            rpc: HOST_RPC_VERSION,
            version: "old",
            pid: process.pid,
            instanceId: "old",
            startedAt: "x",
            plugins: [],
            storeMethods: ["readMemory"],
          },
        }),
      );
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
    mkdirSync(dirname(hostRecordFile(home.env)), { recursive: true });
    writeFileSync(
      hostRecordFile(home.env),
      JSON.stringify({
        schema_version: 1,
        rpc: HOST_RPC_VERSION,
        pid: process.pid,
        port,
        token: "t",
        version: "old",
        instance_id: "old",
        started_at: new Date().toISOString(),
      }),
    );
    const lines: string[] = [];
    const s = session({ log: (line) => lines.push(line) });
    expect(await s.mode()).toBe("degraded");
    expect(lines.join("\n")).toMatch(/does not serve .*writeMemory/);
  });

  it("lists the home's workspaces through a running host, and itself when it runs the host", async () => {
    const running = await startHost({ env: home.env });
    hosts.push(running);
    const s = session();
    const { folder, workspace } = await workspaceWithMemory(s);
    expect(await s.mode()).toBe("client");
    expect(await s.listWorkspaces()).toEqual([
      { id: workspace.workspaceId, name: "Project", rootPath: folder },
    ]);
    await s.markMirror(workspace.workspaceId);
    expect(await s.listWorkspaces()).toEqual([]);
    await s.close();
    await running.stop();

    const own = session();
    const second = join(home.dir, "second");
    mkdirSync(second, { recursive: true });
    const created = await own.initWorkspace({ folder: second, name: "Second" });
    expect(await own.mode()).toBe("own");
    expect(await own.listWorkspaces()).toEqual([
      { id: created.workspaceId, name: "Second", rootPath: second },
    ]);
  });

  it("lists the workspaces itself beside a host that lacks workspace.list", async () => {
    const folder = join(home.dir, "listed");
    mkdirSync(folder, { recursive: true });
    const seeded = session();
    const workspace = await seeded.initWorkspace({ folder, name: "Listed" });
    await seeded.close();
    // An older release's host: every store method, but no workspace.list.
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
          method: string;
        };
        const body =
          request.method === "host.hello"
            ? {
                v: HOST_RPC_VERSION,
                id: request.id,
                ok: true,
                result: {
                  rpc: HOST_RPC_VERSION,
                  version: "old",
                  pid: process.pid,
                  instanceId: "old",
                  startedAt: "x",
                  plugins: [],
                  storeMethods: [...HOST_STORE_CALLABLE],
                },
              }
            : {
                v: HOST_RPC_VERSION,
                id: request.id,
                ok: false,
                error: { code: "method_not_found", message: `no host method "${request.method}"` },
              };
        res.writeHead(body.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );
    mkdirSync(dirname(hostRecordFile(home.env)), { recursive: true });
    writeFileSync(
      hostRecordFile(home.env),
      JSON.stringify({
        schema_version: 1,
        rpc: HOST_RPC_VERSION,
        pid: process.pid,
        port,
        token: "t",
        version: "old",
        instance_id: "old",
        started_at: new Date().toISOString(),
      }),
    );
    const s = session();
    expect(await s.mode()).toBe("client");
    expect(await s.listWorkspaces()).toEqual([
      { id: workspace.workspaceId, name: "Listed", rootPath: folder },
    ]);
  });
});
