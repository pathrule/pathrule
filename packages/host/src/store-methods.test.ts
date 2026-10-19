// SPDX-License-Identifier: Apache-2.0
// The store methods the host serves are exactly LocalBackend's asynchronous public methods, and a
// remote store stands in wherever a LocalKnowledgeBackend is expected. The first two checks are
// types: `tsc` fails (and names the methods) when LocalBackend gains or loses one the list does not.
import { describe, expect, it } from "vitest";

import type { LocalKnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

import type { RemoteStore } from "./remote-store.js";
import {
  HOST_STORE_CALLABLE,
  HOST_STORE_METHODS,
  HOST_STORE_SYNC_METHODS,
  type HostStoreMethod,
  type HostStoreSyncMethod,
} from "./store-methods.js";

/** LocalBackend's public members (`keyof` sees no private ones) that return a promise. */
type AsyncPublicMethods<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

type MissingFromList = Exclude<AsyncPublicMethods<LocalBackend>, HostStoreMethod>;
type NotAnAsyncMethod = Exclude<HostStoreMethod, AsyncPublicMethods<LocalBackend>>;
export const listHasEveryAsyncMethod: [MissingFromList] extends [never] ? true : MissingFromList =
  true;
export const listHasOnlyAsyncMethods: [NotAnAsyncMethod] extends [never] ? true : NotAnAsyncMethod =
  true;

// The synchronous ones a client may call are LocalBackend's, and none returns a promise.
type NotASyncMethod = Exclude<
  HostStoreSyncMethod,
  Exclude<keyof LocalBackend, AsyncPublicMethods<LocalBackend>>
>;
export const syncListHasOnlySyncMethods: [NotASyncMethod] extends [never] ? true : NotASyncMethod =
  true;

// A remote store is assignable to the interface Studio, MCP and the CLI hand around.
type Assignable<T extends LocalKnowledgeBackend> = T;
export type RemoteStoreIsALocalKnowledgeBackend = Assignable<RemoteStore>;

describe("HOST_STORE_METHODS", () => {
  it("names methods that exist on LocalBackend, once each", () => {
    for (const name of HOST_STORE_METHODS) {
      expect(typeof (LocalBackend.prototype as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
    expect(new Set(HOST_STORE_METHODS).size).toBe(HOST_STORE_METHODS.length);
  });

  it("never offers the store's lifetime or its synchronous builders", () => {
    for (const name of ["close", "registerWorkspace", "advisoriesForHookIndex", "capabilities"]) {
      expect(HOST_STORE_METHODS as readonly string[]).not.toContain(name);
    }
  });
});

describe("HOST_STORE_SYNC_METHODS", () => {
  it("names synchronous LocalBackend methods the surfaces use, and never the hook-index builders", () => {
    for (const name of HOST_STORE_SYNC_METHODS) {
      expect(typeof (LocalBackend.prototype as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
    for (const name of ["close", "advisoriesForHookIndex", "selectionsForHookIndex"]) {
      expect(HOST_STORE_CALLABLE as readonly string[]).not.toContain(name);
    }
    expect(new Set(HOST_STORE_CALLABLE).size).toBe(
      HOST_STORE_METHODS.length + HOST_STORE_SYNC_METHODS.length,
    );
  });
});
