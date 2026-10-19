// SPDX-License-Identifier: Apache-2.0
// `signals.ingest`: an application's runtime events reach the workspace that covers its folder,
// only from a client holding the host's token and never from a browser.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HOST_RPC_VERSION } from "@pathrule/protocol/host-rpc.js";

import { rawRequest, scratchHome, type ScratchHome } from "./__fixtures__/helpers.js";
import { createHostClient } from "./client.js";
import { startHost, type RunningHost } from "./host.js";

let home: ScratchHome;
let host: RunningHost;

beforeEach(async () => {
  home = scratchHome();
  host = await startHost({ env: home.env });
});

afterEach(async () => {
  await host.stop();
  home.remove();
});

const envelope = {
  schemaVersion: 1,
  id: "env_1",
  environment: "development",
  release: "1.0.0",
  items: [
    {
      type: "signal",
      kind: "error",
      fingerprint: "fp1",
      countDelta: 1,
      node: "/api",
      flow: "login",
    },
  ],
};

describe("signals.ingest", () => {
  it("stores the envelope in the workspace covering the folder, once per envelope id", async () => {
    const client = createHostClient(host.record);
    const folder = join(home.dir, "app");
    mkdirSync(join(folder, "server"), { recursive: true });
    const created = (await client.call("workspace.init", { folder })) as { workspaceId: string };
    const cwd = join(folder, "server");
    await expect(client.call("signals.ingest", { cwd, envelope })).resolves.toEqual({
      status: "accepted",
      accepted: 1,
      declared: 0,
    });
    await expect(client.call("signals.ingest", { cwd, envelope })).resolves.toMatchObject({
      status: "duplicate",
    });
    const page = (await client.call("store.invoke", {
      workspaceId: created.workspaceId,
      method: "listRuntimeEventGroups",
      args: [created.workspaceId, {}],
    })) as { value: { items: Array<{ fingerprint: string; nodePath: string }> } };
    expect(page.value.items).toMatchObject([{ fingerprint: "fp1", nodePath: "/api" }]);
    // The hook's file: paths and counts, private to this user.
    const file = join(
      home.env.PATHRULE_HOME!,
      "cache",
      created.workspaceId,
      "runtime-indicator.json",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      v: 1,
      paths: [{ path: "api", active: 1, recurred: 0 }],
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a folder no workspace covers, and a relative cwd", async () => {
    const client = createHostClient(host.record);
    await expect(
      client.call("signals.ingest", { cwd: join(home.dir, "nowhere"), envelope }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(client.call("signals.ingest", { cwd: "app", envelope })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("is closed to a browser and to a request without the token", async () => {
    const body = JSON.stringify({
      v: HOST_RPC_VERSION,
      id: 1,
      method: "signals.ingest",
      params: { cwd: home.dir, envelope },
    });
    const hostHeader = `127.0.0.1:${host.record.port}`;
    const browser = await rawRequest({
      port: host.record.port,
      headers: {
        host: hostHeader,
        origin: "https://evil.example",
        authorization: `Bearer ${host.record.token}`,
        "content-type": "application/json",
      },
      body,
    });
    expect(browser.status).toBe(403);
    const anonymous = await rawRequest({
      port: host.record.port,
      headers: { host: hostHeader, "content-type": "application/json" },
      body,
    });
    expect(anonymous.status).toBe(401);
  });
});
