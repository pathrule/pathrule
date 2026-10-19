// SPDX-License-Identifier: Apache-2.0
// A remote store behaves like the LocalBackend behind it. Core's backend contract suite, the one
// LocalBackend and the in-memory reference pass, runs against a remote store whose every call goes
// through the host's own store dispatch and a JSON round trip each way, as on the wire. A second
// block drives a real host over HTTP.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTRACT_TEST_EMBED,
  runKnowledgeBackendContract,
} from "@pathrule/core/backend/contract-suite.js";
import type { LocalKnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

import { scratchHome, type ScratchHome } from "./__fixtures__/helpers.js";
import { connectHost, HostClientError } from "./client.js";
import { startHost, type RunningHost } from "./host.js";
import { HostRpcFailure } from "./methods.js";
import {
  connectRemoteStore,
  createRemoteStore,
  encodeArgs,
  rethrowStoreError,
  type StoreTransport,
} from "./remote-store.js";
import { invokeStoreMethod, parseStoreCall, storeFailure } from "./store-rpc.js";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The wire without HTTP: the params and the result each cross JSON, through the host's dispatch. */
function wireTransport(store: LocalBackend): StoreTransport {
  return async (call) => {
    const params = roundTrip({ workspaceId: "ws-wire", ...call });
    try {
      const parsed = parseStoreCall(params);
      return roundTrip(await invokeStoreMethod(store, parsed.method, parsed.args));
    } catch (err) {
      if (err instanceof HostRpcFailure) {
        throw new HostClientError(err.code, err.message, 500, roundTrip(err.data));
      }
      throw err;
    }
  };
}

runKnowledgeBackendContract("the host's remote store (JSON wire)", () => {
  let counter = 0;
  const local = new LocalBackend(":memory:", {
    genId: () => `id-${++counter}`,
    now: () => "2026-06-04T00:00:00.000Z",
    embed: CONTRACT_TEST_EMBED,
  });
  return createRemoteStore({
    capabilities: roundTrip(local.capabilities()),
    transport: wireTransport(local),
  }) as LocalKnowledgeBackend;
});

describe("the wire's edges", () => {
  it("carries undefined arguments by position and drops trailing ones", () => {
    expect(encodeArgs([1, undefined, 3, undefined])).toEqual({
      args: [1, null, 3],
      undefinedArgs: [1],
    });
    expect(encodeArgs(["a", undefined])).toEqual({ args: ["a"] });
    expect(
      parseStoreCall({
        workspaceId: "w",
        method: "readMemory",
        args: [1, null, 3],
        undefinedArgs: [1],
      }).args,
    ).toEqual([1, undefined, 3]);
  });

  it("tells an undefined result from null", async () => {
    const store = {
      readMemory: async () => undefined,
      readRule: async () => null,
    } as unknown as LocalBackend;
    await expect(invokeStoreMethod(store, "readMemory", [])).resolves.toEqual({});
    await expect(invokeStoreMethod(store, "readRule", [])).resolves.toEqual({ value: null });
  });

  it("throws a store error again with its name, message and fields", () => {
    const original = Object.assign(new Error("content_version_conflict"), {
      name: "ConflictError",
      code: "conflict",
      detail: { current_version_id: "v2" },
    });
    const failure = storeFailure(original);
    let thrown: unknown;
    try {
      rethrowStoreError(
        new HostClientError(failure.code, failure.message, 500, roundTrip(failure.data)),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: "ConflictError",
      message: "content_version_conflict",
      code: "conflict",
      detail: { current_version_id: "v2" },
    });
    expect(storeFailure("plain")).toMatchObject({ code: "store_error", message: "plain" });
  });

  it.each([
    [{}, "needs a workspaceId"],
    [{ workspaceId: "w", method: "close" }, "not a store method"],
    [{ workspaceId: "w", method: "advisoriesForHookIndex" }, "not a store method"],
    [{ workspaceId: "w", method: "readMemory", args: "x" }, "args must be an array"],
    [
      { workspaceId: "w", method: "readMemory", args: [], undefinedArgs: [0] },
      "positions within args",
    ],
  ])("refuses the call %j", (params, message) => {
    expect(() => parseStoreCall(params)).toThrow(message);
  });
});

describe("over a real host", () => {
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

  it("writes, reads and conflicts like the store behind it, and opens it once", async () => {
    const client = (await connectHost({ env: home.env }))!;
    const store = await connectRemoteStore(client, "ws-http");
    const local = new LocalBackend(":memory:");
    expect(store.capabilities()).toEqual(roundTrip(local.capabilities()));
    local.close();

    const created = await store.writeMemory({
      workspaceId: "ws-http",
      nodeId: "n1",
      title: "T",
      content: "C",
    });
    expect(await store.readMemory(created.id)).toEqual(created);
    expect(await store.readMemory("missing")).toBeNull();
    await store.updateMemory({
      id: created.id,
      content: "C2",
      expectedVersionId: created.versionId,
    });
    await expect(
      store.updateMemory({ id: created.id, content: "C3", expectedVersionId: created.versionId }),
    ).rejects.toThrow("content_version_conflict");
    expect(await store.listMemories({ workspaceId: "ws-http" })).toHaveLength(1);
    expect(host.stores.openWorkspaceIds()).toEqual(["ws-http"]);
  });

  it("refuses a workspace id that could leave the Pathrule home, and an unlisted method", async () => {
    const client = (await connectHost({ env: home.env }))!;
    await expect(connectRemoteStore(client, "../escape")).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      client.call("store.invoke", { workspaceId: "ws-http", method: "close", args: [] }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(host.stores.openWorkspaceIds()).toEqual([]);
  });

  it("answers shutting_down once the host stopped its stores", async () => {
    const client = (await connectHost({ env: home.env }))!;
    const store = await connectRemoteStore(client, "ws-http");
    host.stores.closeAll();
    await expect(store.listMemories({ workspaceId: "ws-http" })).rejects.toMatchObject({
      code: "shutting_down",
    });
  });
});
