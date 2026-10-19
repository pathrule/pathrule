// SPDX-License-Identifier: Apache-2.0
// The host's lifecycle and its plugin seam: one host per Pathrule home, a crash's record replaced,
// a clean stop that drains and leaves nothing behind, and plugins refused, failed or active.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { HOST_RPC_VERSION, type HostDiscoveryRecord } from "@pathrule/protocol/host-rpc.js";
import { packageInstance } from "@pathrule/protocol/package-instance.js";
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { scratchHome, sleep, waitFor, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost, createHostClient, HostClientError } from "./client.js";
import { HostAlreadyRunningError, hostRecordFile, readHostRecord } from "./discovery.js";
import { startHost, type RunningHost } from "./host.js";
import type { HostPlugin } from "./plugin.js";

let home: ScratchHome;
const running: RunningHost[] = [];

async function start(options: Parameters<typeof startHost>[0] = {}): Promise<RunningHost> {
  const host = await startHost({ env: home.env, ...options });
  running.push(host);
  return host;
}

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

function writeRecord(record: Partial<HostDiscoveryRecord>): void {
  const full: HostDiscoveryRecord = {
    schema_version: 1,
    rpc: HOST_RPC_VERSION,
    pid: process.pid,
    port: 1,
    token: "t",
    version: "x",
    instance_id: "someone-else",
    started_at: new Date().toISOString(),
    ...record,
  };
  const file = hostRecordFile(home.env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(full));
}

const plugin = (overrides: Partial<HostPlugin> & { name: string }): HostPlugin => ({
  contract: HOST_PLUGIN_CONTRACT,
  sharedPackages: [CORE_PACKAGE],
  ...overrides,
});

beforeEach(() => {
  home = scratchHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  home.remove();
});

describe("one host per Pathrule home", () => {
  it("publishes a private record and answers the handshake", async () => {
    const host = await start({ version: "9.9.9" });
    const file = hostRecordFile(home.env);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    const record = JSON.parse(readFileSync(file, "utf8")) as HostDiscoveryRecord;
    expect(record).toMatchObject({
      schema_version: 1,
      rpc: HOST_RPC_VERSION,
      pid: process.pid,
      version: "9.9.9",
    });
    expect(record.token).toHaveLength(43);
    expect(record.port).toBe(host.record.port);

    const client = await connectHost({ env: home.env });
    const hello = await client!.call("host.hello", {});
    expect(hello).toMatchObject({
      rpc: HOST_RPC_VERSION,
      pid: process.pid,
      instanceId: record.instance_id,
      plugins: [],
    });
  });

  it("refuses a second host while the first one lives", async () => {
    const first = await start();
    await expect(start()).rejects.toBeInstanceOf(HostAlreadyRunningError);
    expect((await readHostRecord(home.env))?.instance_id).toBe(first.record.instance_id);
  });

  it("lets exactly one of several hosts that start at once win", async () => {
    const results = await Promise.allSettled([start(), start(), start(), start()]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(3);
    for (const r of lost)
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(HostAlreadyRunningError);
    // The losers closed their ports: only the winner answers.
    const record = await readHostRecord(home.env);
    expect(record?.instance_id).toBe(
      (won[0] as PromiseFulfilledResult<RunningHost>).value.record.instance_id,
    );
  });

  it("takes over the record a crashed host left behind", async () => {
    writeRecord({ pid: deadPid(), instance_id: "crashed" });
    const host = await start();
    expect((await readHostRecord(home.env))?.instance_id).toBe(host.record.instance_id);
  });

  it("refuses a record whose pid is alive, whoever wrote it", async () => {
    writeRecord({ pid: process.pid, instance_id: "alive" });
    await expect(start()).rejects.toThrow(/already running .*pid/);
  });

  it("ignores an unreadable record", async () => {
    const file = hostRecordFile(home.env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ half a reco");
    const host = await start();
    expect((await readHostRecord(home.env))?.instance_id).toBe(host.record.instance_id);
  });
});

describe("stopping", () => {
  it("removes the record and refuses new requests, and stop is idempotent", async () => {
    const host = await start();
    const client = createHostClient(host.record);
    const first = host.stop();
    expect(host.stop()).toBe(first);
    await first;
    expect(existsSync(hostRecordFile(home.env))).toBe(false);
    await expect(client.call("host.hello", {}, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("never removes the record of a host that replaced it", async () => {
    const host = await start();
    writeRecord({ pid: process.pid, instance_id: "newer" });
    await host.stop();
    expect((await readHostRecord(home.env))?.instance_id).toBe("newer");
  });

  it("stops on host.shutdown after answering it", async () => {
    const host = await start();
    const client = createHostClient(host.record);
    await expect(client.call("host.shutdown", {})).resolves.toEqual({ stopping: true });
    await host.stopped;
    expect(existsSync(hostRecordFile(home.env))).toBe(false);
  });

  it("lets a request in flight finish before it stops", async () => {
    const host = await start({
      plugins: [
        plugin({
          name: "slow",
          activate: (ctx) => ctx.registerMethod("work", async () => (await sleep(300), "done")),
        }),
      ],
    });
    const client = createHostClient(host.record);
    const call = client.callPlugin("slow.work");
    await sleep(50);
    await host.stop();
    await expect(call).resolves.toBe("done");
  });

  it("drops a request that outlives the drain deadline, and still stops", async () => {
    const host = await start({
      drainTimeoutMs: 100,
      plugins: [
        plugin({
          name: "stuck",
          activate: (ctx) => ctx.registerMethod("work", () => new Promise(() => {})),
        }),
      ],
    });
    // Settled into a value at once, so the rejection that comes during stop is never unhandled.
    const outcome = createHostClient(host.record)
      .callPlugin("stuck.work")
      .then(
        () => "answered",
        (err: unknown) => err,
      );
    await sleep(50);
    const began = Date.now();
    await host.stop();
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(await outcome).toBeInstanceOf(HostClientError);
    expect(existsSync(hostRecordFile(home.env))).toBe(false);
  });

  it("closes every store it opened", async () => {
    const closed: string[] = [];
    const host = await start({
      openStore: (id) => ({ close: () => closed.push(id) }) as never,
    });
    host.stores.get("ws-a");
    host.stores.get("ws-b");
    await host.stop();
    expect(closed.sort()).toEqual(["ws-a", "ws-b"]);
  });
});

describe("plugins", () => {
  it("serves an active plugin's methods under its name", async () => {
    const host = await start({
      plugins: [
        plugin({ name: "demo", activate: (ctx) => ctx.registerMethod("echo", (params) => params) }),
      ],
    });
    expect(host.plugins).toEqual([
      { name: "demo", contract: HOST_PLUGIN_CONTRACT, state: "active" },
    ]);
    const client = createHostClient(host.record);
    await expect(client.callPlugin("demo.echo", { a: 1 })).resolves.toEqual({ a: 1 });
  });

  it("refuses a plugin built for another contract, and runs without it", async () => {
    let activated = false;
    const host = await start({
      plugins: [
        plugin({
          name: "old",
          contract: HOST_PLUGIN_CONTRACT + 1,
          activate: () => void (activated = true),
        }),
      ],
    });
    expect(activated).toBe(false);
    expect(host.plugins[0]).toMatchObject({ name: "old", state: "refused" });
    expect(host.plugins[0]?.reason).toContain(
      `built for host plugin contract ${HOST_PLUGIN_CONTRACT + 1}`,
    );
    const hello = await createHostClient(host.record).call("host.hello", {});
    expect(hello.plugins[0]).toMatchObject({ name: "old", state: "refused" });
  });

  it("refuses a plugin that resolved a second copy of core", async () => {
    const otherCore = packageInstance(
      "@pathrule/core",
      "file:///elsewhere/core/package-instance.js",
    );
    const host = await start({ plugins: [plugin({ name: "dup", sharedPackages: [otherCore] })] });
    expect(host.plugins[0]).toMatchObject({ state: "refused" });
    expect(host.plugins[0]?.reason).toContain("loaded a second copy of @pathrule/core");
  });

  it("refuses names it cannot give", async () => {
    const host = await start({
      plugins: [
        plugin({ name: "host" }),
        plugin({ name: "workspace" }),
        plugin({ name: "Bad_Name" }),
        plugin({ name: "team" }),
        plugin({ name: "team" }),
      ],
    });
    expect(host.plugins.map((p) => [p.name, p.state])).toEqual([
      ["host", "refused"],
      ["workspace", "refused"],
      ["Bad_Name", "refused"],
      ["team", "refused"],
      ["team", "active"],
    ]);
  });

  it("reports a plugin whose activation throws, serves none of its methods, and keeps serving", async () => {
    const host = await start({
      plugins: [
        plugin({
          name: "broken",
          activate(ctx) {
            ctx.registerMethod("early", () => "registered before the throw");
            throw new Error("activation broke");
          },
        }),
        plugin({ name: "fine", activate: (ctx) => ctx.registerMethod("ping", () => "pong") }),
      ],
    });
    expect(host.plugins).toEqual([
      {
        name: "broken",
        contract: HOST_PLUGIN_CONTRACT,
        state: "failed",
        reason: "activation broke",
      },
      { name: "fine", contract: HOST_PLUGIN_CONTRACT, state: "active" },
    ]);
    const client = createHostClient(host.record);
    await expect(client.callPlugin("broken.early")).rejects.toMatchObject({
      code: "method_not_found",
    });
    await expect(client.callPlugin("fine.ping")).resolves.toBe("pong");
  });

  it("fails a plugin whose activation hangs, within the deadline", async () => {
    const host = await start({
      activationTimeoutMs: 100,
      plugins: [plugin({ name: "hang", activate: () => new Promise(() => {}) })],
    });
    expect(host.plugins[0]).toMatchObject({
      state: "failed",
      reason: "hang activation took longer than 100 ms",
    });
  });

  it("refuses a method registered after activation", async () => {
    let late: ((name: string) => void) | undefined;
    await start({
      plugins: [
        plugin({
          name: "late",
          activate: (ctx) => void (late = (m) => ctx.registerMethod(m, () => 1)),
        }),
      ],
    });
    expect(() => late?.("later")).toThrow(/after its activation/);
  });

  it("deactivates every activated plugin in reverse order, failed ones included", async () => {
    const order: string[] = [];
    const host = await start({
      plugins: [
        plugin({ name: "a", deactivate: () => void order.push("a") }),
        plugin({
          name: "b",
          activate: () => {
            throw new Error("no");
          },
          deactivate: () => void order.push("b"),
        }),
        plugin({
          name: "c",
          deactivate: () => {
            order.push("c");
            throw new Error("deactivation broke");
          },
        }),
        plugin({ name: "refused", contract: 0, deactivate: () => void order.push("refused") }),
      ],
    });
    await host.stop();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("takes one account edition, refuses a second, and drops the one of a plugin that failed", async () => {
    const edition = () => ({
      resolveBackend: async () => null,
      identity: async () => "someone",
      turnContext: {
        sessionKey: () => null,
        sections: async () => ({ retrieval: { delta: "", version: "" }, intelligenceBlock: "" }),
        afterRender: async () => {},
      },
    });
    const host = await start({
      plugins: [
        plugin({
          name: "broken",
          activate: (ctx) => {
            ctx.provideAccount(edition());
            throw new Error("boom");
          },
        }),
        plugin({ name: "first", activate: (ctx) => ctx.provideAccount(edition()) }),
        plugin({ name: "second", activate: (ctx) => ctx.provideAccount(edition()) }),
      ],
    });
    expect(host.plugins.map((p) => `${p.name} ${p.state}`)).toEqual([
      "broken failed",
      "first active",
      "second failed",
    ]);
    expect(host.plugins[2]!.reason).toBe("first already provides the account; second cannot");
  });

  it("refuses an account provided after activation", async () => {
    let later: (() => void) | null = null;
    await start({
      plugins: [
        plugin({
          name: "late",
          activate: (ctx) => {
            later = () =>
              ctx.provideAccount({
                resolveBackend: async () => null,
                identity: async () => "x",
                turnContext: {} as never,
              });
          },
        }),
      ],
    });
    expect(() => later!()).toThrow("late provided an account after its activation");
  });

  it("gives a plugin the host's stores", async () => {
    let given: unknown = null;
    const host = await start({
      plugins: [plugin({ name: "copies", activate: (ctx) => void (given = ctx.stores) })],
    });
    expect(given).toBe(host.stores);
  });

  it("holds a request that arrives during activation until the plugins are ready", async () => {
    let finishActivation!: () => void;
    const starting = startHost({
      env: home.env,
      plugins: [
        plugin({
          name: "gate",
          activate: (ctx) =>
            new Promise<void>((resolve) => {
              ctx.registerMethod("open", () => "open");
              finishActivation = resolve;
            }),
        }),
      ],
    });
    const record = await waitFor(() => readHostRecord(home.env).then((r) => r ?? undefined));
    const call = createHostClient(record).callPlugin("gate.open");
    await sleep(100);
    finishActivation();
    running.push(await starting);
    await expect(call).resolves.toBe("open");
  });
});

describe("the client", () => {
  it("finds no host without a record, or when its process is gone", async () => {
    await expect(connectHost({ env: home.env })).resolves.toBeNull();
    writeRecord({ pid: deadPid() });
    await expect(connectHost({ env: home.env })).resolves.toBeNull();
  });

  it("refuses a host of another RPC version without calling it", async () => {
    writeRecord({ pid: process.pid, rpc: HOST_RPC_VERSION + 1 });
    await expect(connectHost({ env: home.env })).rejects.toMatchObject({
      code: "rpc_version_mismatch",
    });
  });

  it("reports a recorded host that does not answer", async () => {
    writeRecord({ pid: process.pid, port: 9 });
    await expect(connectHost({ env: home.env, timeoutMs: 500 })).rejects.toMatchObject({
      code: "unreachable",
    });
  });

  it("refuses an answer from another instance than the record names", async () => {
    const host = await start();
    writeRecord({ ...host.record, instance_id: "not-the-one" });
    await expect(connectHost({ env: home.env })).rejects.toThrow(/not the one the record names/);
  });
});
