// SPDX-License-Identifier: Apache-2.0
/**
 * A local store reached through the host. It has the methods of core's `LocalBackend` that the host
 * serves (every asynchronous one, the few synchronous ones in `HOST_STORE_SYNC_METHODS`, answered
 * asynchronously here, and `capabilities`), and each is one `store.invoke` call. A process
 * that ran `LocalBackend` itself (Studio's main process, later the MCP server and the CLI) hands this
 * object to the same code, and the host stays the store's only owner.
 *
 * What the wire changes, and how it is kept faithful:
 * - **Arguments and results are JSON.** An `undefined` argument and an `undefined` result are carried
 *   explicitly; an `undefined` field inside an object is dropped, which every reader of these shapes
 *   treats the same as absent.
 * - **A store error is thrown again** with its name, message and own fields (`code`, `detail`). Its
 *   class is not: callers here compare messages and codes, never classes.
 * - **`capabilities()` is read once,** when the remote store is created. The host installs its
 *   engine before it serves, so the value does not change while the host runs.
 *
 * Core's backend contract suite runs against this object (`remote-store.test.ts`).
 */
import type { BackendCapabilities } from "@pathrule/core/backend/capabilities.js";
import type { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import type { HostStoreErrorData } from "@pathrule/protocol/host-rpc.js";

import { HostClientError, type HostCallOptions, type HostClient } from "./client.js";
import {
  HOST_STORE_CALLABLE,
  type HostStoreMethod,
  type HostStoreSyncMethod,
} from "./store-methods.js";

/** A synchronous store method as a remote store answers it: the same, but awaited. */
type Awaited_<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

/** What a local store and a remote one share: the asynchronous methods and `capabilities`. */
export type StoreSurface = Pick<LocalBackend, HostStoreMethod | "capabilities">;

export type RemoteStore = StoreSurface & {
  [K in HostStoreSyncMethod]: Awaited_<LocalBackend[K]>;
};

/** One call on the wire: the encoded arguments out, the encoded result back. */
export type StoreTransport = (call: {
  method: HostStoreMethod | HostStoreSyncMethod;
  args: unknown[];
  undefinedArgs?: number[];
}) => Promise<{ value?: unknown }>;

/** Trailing `undefined` arguments are dropped; any other position is listed in `undefinedArgs`. */
export function encodeArgs(args: readonly unknown[]): {
  args: unknown[];
  undefinedArgs?: number[];
} {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  const kept = args.slice(0, end);
  const undefinedArgs = kept.flatMap((arg, i) => (arg === undefined ? [i] : []));
  return undefinedArgs.length === 0
    ? { args: kept }
    : { args: kept.map((arg) => (arg === undefined ? null : arg)), undefinedArgs };
}

function isStoreErrorData(value: unknown): value is HostStoreErrorData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<HostStoreErrorData>;
  return typeof data.name === "string" && !!data.fields && typeof data.fields === "object";
}

/** Throws the error a store method threw in the host again here; anything else as it is. */
export function rethrowStoreError(err: unknown): never {
  if (err instanceof HostClientError && err.code === "store_error" && isStoreErrorData(err.data)) {
    const restored = new Error(err.message);
    restored.name = err.data.name;
    Object.assign(restored, err.data.fields);
    throw restored;
  }
  throw err;
}

export function createRemoteStore(input: {
  transport: StoreTransport;
  capabilities: BackendCapabilities;
}): RemoteStore {
  const capabilities = { ...input.capabilities };
  const store: Record<string, unknown> = { capabilities: () => ({ ...capabilities }) };
  for (const method of HOST_STORE_CALLABLE) {
    store[method] = async (...args: unknown[]) => {
      try {
        const result = await input.transport({ method, ...encodeArgs(args) });
        return result.value;
      } catch (err) {
        rethrowStoreError(err);
      }
    };
  }
  return store as unknown as RemoteStore;
}

/** The store of `workspaceId` on the host `client` talks to. The host opens it on first use. */
export async function connectRemoteStore(
  client: HostClient,
  workspaceId: string,
  options: HostCallOptions = {},
): Promise<RemoteStore> {
  const capabilities = await client.call("store.capabilities", { workspaceId }, options);
  return createRemoteStore({
    capabilities: capabilities as unknown as BackendCapabilities,
    transport: (call) => client.call("store.invoke", { workspaceId, ...call }, options),
  });
}
