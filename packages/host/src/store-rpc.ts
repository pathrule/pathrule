// SPDX-License-Identifier: Apache-2.0
/**
 * The host's side of `store.invoke`: check the call, run it on the store the host owns, and turn
 * whatever the store throws into a `store_error` that the client throws again
 * (./remote-store.ts).
 */
import type { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";
import type { HostStoreErrorData } from "@pathrule/protocol/host-rpc.js";

import { HostRpcFailure } from "./methods.js";
import {
  isHostStoreMethod,
  type HostStoreMethod,
  type HostStoreSyncMethod,
} from "./store-methods.js";

export interface StoreCall {
  workspaceId: string;
  method: HostStoreMethod | HostStoreSyncMethod;
  args: unknown[];
}

/** The params of `store.invoke`, with the `undefined` arguments put back where they were. */
export function parseStoreCall(params: unknown): StoreCall {
  const value = (params ?? {}) as {
    workspaceId?: unknown;
    method?: unknown;
    args?: unknown;
    undefinedArgs?: unknown;
  };
  if (typeof value.workspaceId !== "string") {
    throw new HostRpcFailure("invalid_params", "store.invoke needs a workspaceId");
  }
  if (typeof value.method !== "string" || !isHostStoreMethod(value.method)) {
    throw new HostRpcFailure(
      "invalid_params",
      `"${String(value.method)}" is not a store method a client may call`,
    );
  }
  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new HostRpcFailure("invalid_params", "args must be an array");
  }
  const args: unknown[] = [...((value.args as unknown[] | undefined) ?? [])];
  if (value.undefinedArgs !== undefined) {
    const positions = value.undefinedArgs;
    if (
      !Array.isArray(positions) ||
      !positions.every((i) => Number.isInteger(i) && i >= 0 && i < args.length)
    ) {
      throw new HostRpcFailure("invalid_params", "undefinedArgs must list positions within args");
    }
    for (const i of positions as number[]) args[i] = undefined;
  }
  return { workspaceId: value.workspaceId, method: value.method, args };
}

function jsonSafe(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** A thrown store error as the client will see it: its name, message and own JSON fields. */
export function storeFailure(err: unknown): HostRpcFailure {
  if (!(err instanceof Error)) {
    const data: HostStoreErrorData = { name: "Error", fields: {} };
    return new HostRpcFailure("store_error", String(err), data);
  }
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(err)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    if (jsonSafe(field)) fields[key] = field;
  }
  const data: HostStoreErrorData = { name: err.name, fields };
  return new HostRpcFailure("store_error", err.message, data);
}

/** Runs one store method. A result without `value` means the method returned `undefined`. */
export async function invokeStoreMethod(
  store: LocalBackend,
  method: HostStoreMethod | HostStoreSyncMethod,
  args: unknown[],
): Promise<{ value?: unknown }> {
  const fn = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
  if (typeof fn !== "function") {
    throw new HostRpcFailure("invalid_params", `the store has no method "${method}"`);
  }
  let value: unknown;
  try {
    value = await fn.apply(store, args);
  } catch (err) {
    throw storeFailure(err);
  }
  return value === undefined ? {} : { value };
}
