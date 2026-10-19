// SPDX-License-Identifier: Apache-2.0
// A host that stops by itself when idle: no request for the timeout, none in flight, and no plugin
// keeping it running. A host without a timeout never does.
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { HOST_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { scratchHome, sleep, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost } from "./client.js";
import { hostRecordFile } from "./discovery.js";
import { startHost, type RunningHost } from "./host.js";
import { IdleWatch } from "./idle.js";
import type { HostPlugin, HostPluginContext } from "./plugin.js";

let home: ScratchHome;
const running: RunningHost[] = [];

async function start(options: Parameters<typeof startHost>[0] = {}): Promise<RunningHost> {
  const host = await startHost({ env: home.env, ...options });
  running.push(host);
  return host;
}

const plugin = (overrides: Partial<HostPlugin> & { name: string }): HostPlugin => ({
  contract: HOST_PLUGIN_CONTRACT,
  sharedPackages: [CORE_PACKAGE],
  ...overrides,
});

/** Settles with true when the host stopped within `ms`, false otherwise. */
function stoppedWithin(host: RunningHost, ms: number): Promise<boolean> {
  return Promise.race([host.stopped.then(() => true), sleep(ms).then(() => false)]);
}

beforeEach(() => {
  home = scratchHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((host) => host.stop()));
  home.remove();
});

describe("a host with an idle timeout", () => {
  it("stops after the timeout without a request, and removes its record", async () => {
    const host = await start({ idleTimeoutMs: 150 });
    expect(await stoppedWithin(host, 2_000)).toBe(true);
    expect(existsSync(hostRecordFile(home.env))).toBe(false);
  });

  it("starts the period over with every request", async () => {
    const host = await start({ idleTimeoutMs: 300 });
    const client = await connectHost({ env: home.env });
    for (let i = 0; i < 5; i += 1) {
      await sleep(150);
      await client!.call("host.hello", {});
    }
    // 750 ms have passed: more than twice the timeout, but never 300 ms without a request.
    expect(await stoppedWithin(host, 0)).toBe(false);
    expect(await stoppedWithin(host, 2_000)).toBe(true);
  });

  it("does not stop while a request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const host = await start({
      idleTimeoutMs: 100,
      plugins: [
        plugin({
          name: "slow",
          activate(context) {
            context.registerMethod("wait", () => gate.then(() => ({ done: true })));
          },
        }),
      ],
    });
    const client = await connectHost({ env: home.env });
    const pending = client!.callPlugin("slow.wait");
    expect(await stoppedWithin(host, 400)).toBe(false);
    release();
    expect(await pending).toEqual({ done: true });
    expect(await stoppedWithin(host, 2_000)).toBe(true);
  });

  it("keeps running while a plugin holds it, and reports who does", async () => {
    let context!: HostPluginContext;
    const host = await start({
      idleTimeoutMs: 100,
      plugins: [plugin({ name: "worker", activate: (c) => void (context = c) })],
    });
    const release = context.keepAlive("signed in");
    const hello = await (await connectHost({ env: home.env }))!.call("host.hello", {});
    expect(hello.idle).toEqual({ timeoutMs: 100, heldBy: ["worker: signed in"] });
    expect(await stoppedWithin(host, 400)).toBe(false);
    release();
    release(); // twice is harmless
    expect(await stoppedWithin(host, 2_000)).toBe(true);
  });

  it("drops the holds of a plugin whose activation fails", async () => {
    let context!: HostPluginContext;
    const host = await start({
      idleTimeoutMs: 100,
      plugins: [
        plugin({
          name: "broken",
          activate(c) {
            context = c;
            c.keepAlive("before failing");
            throw new Error("no");
          },
        }),
      ],
    });
    expect(host.plugins[0]).toMatchObject({ name: "broken", state: "failed" });
    // A late hold from the failed plugin keeps nothing running either.
    context.keepAlive("after failing");
    expect(await stoppedWithin(host, 2_000)).toBe(true);
  });
});

describe("a host without an idle timeout", () => {
  it("keeps running and says nothing about idling", async () => {
    const host = await start();
    const hello = await (await connectHost({ env: home.env }))!.call("host.hello", {});
    expect(hello.idle).toBeUndefined();
    expect(await stoppedWithin(host, 300)).toBe(false);
  });
});

describe("IdleWatch", () => {
  it("never fires before it starts, nor after it closes", async () => {
    let fired = 0;
    const watch = new IdleWatch(20, () => (fired += 1));
    await sleep(60);
    expect(fired).toBe(0);
    watch.start();
    watch.close();
    await sleep(60);
    expect(fired).toBe(0);
    expect(watch.hold("late")()).toBeUndefined();
  });
});
