// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheGet,
  cacheInvalidate,
  cacheInvalidateKind,
  cachePut,
  clearCacheIdentity,
  purgeStaleEpochCaches,
  setCacheIdentity,
} from "../cache.js";

let originalRoot: string | undefined;
let tmpRoot: string;

beforeEach(async () => {
  originalRoot = process.env.PATHRULE_CACHE_ROOT;
  tmpRoot = await mkdtemp(path.join(tmpdir(), "pathrule-cache-test-"));
  process.env.PATHRULE_CACHE_ROOT = tmpRoot;
  clearCacheIdentity();
});

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.PATHRULE_CACHE_ROOT;
  else process.env.PATHRULE_CACHE_ROOT = originalRoot;
  clearCacheIdentity();
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("cache", () => {
  it("miss on cold filesystem returns null", async () => {
    const hit = await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" });
    expect(hit).toBeNull();
  });

  it("put + get round-trip within TTL", async () => {
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { hello: "world" });
    const hit = await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" });
    expect(hit).toEqual({ hello: "world" });
  });

  it("returns null when TTL has expired", async () => {
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { hello: "world" });
    // Negative TTL → every read is stale (Date.now() - mtime always > -1).
    const hit = await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" }, -1);
    expect(hit).toBeNull();
  });

  it("invalidate removes the entry", async () => {
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { hello: "world" });
    await cacheInvalidate({ workspaceId: "w1", kind: "memory", id: "m1" });
    const hit = await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" });
    expect(hit).toBeNull();
  });

  it("different kinds do not collide", async () => {
    await cachePut({ workspaceId: "w1", kind: "memory", id: "shared" }, { a: 1 });
    await cachePut({ workspaceId: "w1", kind: "rule", id: "shared" }, { b: 2 });
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "shared" })).toEqual({ a: 1 });
    expect(await cacheGet({ workspaceId: "w1", kind: "rule", id: "shared" })).toEqual({ b: 2 });
  });

  it("cacheInvalidateKind drops every entry of a kind but leaves other kinds", async () => {
    // Per-path context entries (the real shape — `_all` never matched these).
    await cachePut({ workspaceId: "w1", kind: "context", id: "__root__" }, { c: 0 });
    await cachePut({ workspaceId: "w1", kind: "context", id: "/lib" }, { c: 1 });
    await cachePut({ workspaceId: "w1", kind: "context", id: "/api" }, { c: 2 });
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { keep: true });

    await cacheInvalidateKind({ workspaceId: "w1", kind: "context" });

    expect(await cacheGet({ workspaceId: "w1", kind: "context", id: "__root__" })).toBeNull();
    expect(await cacheGet({ workspaceId: "w1", kind: "context", id: "/lib" })).toBeNull();
    expect(await cacheGet({ workspaceId: "w1", kind: "context", id: "/api" })).toBeNull();
    // Other kinds and other workspaces are untouched.
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" })).toEqual({ keep: true });
  });

  it("unsafe ids are sanitized so they don't escape the workspace dir", async () => {
    await cachePut({ workspaceId: "w1", kind: "memory", id: "../../etc/passwd" }, { ok: true });
    // Shouldn't explode; safeId replaces path separators with underscore.
    const hit = await cacheGet({ workspaceId: "w1", kind: "memory", id: "../../etc/passwd" });
    expect(hit).toEqual({ ok: true });
  });

  it("does not serve cache entries across security epochs", async () => {
    setCacheIdentity("user-1", 0);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { epoch: 0 });

    setCacheIdentity("user-1", 1);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" })).toBeNull();
  });

  it("does not serve cache entries across users", async () => {
    setCacheIdentity("user-1", 0);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { user: "one" });

    setCacheIdentity("user-2", 0);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" })).toBeNull();
  });

  it("purges only older epoch directories for the current user", async () => {
    setCacheIdentity("user-1", 0);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m0" }, { epoch: 0 });
    setCacheIdentity("user-1", 1);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m1" }, { epoch: 1 });
    setCacheIdentity("user-1", 2);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "m2" }, { epoch: 2 });
    setCacheIdentity("user-2", 0);
    await cachePut({ workspaceId: "w1", kind: "memory", id: "other" }, { epoch: 0 });

    expect(await purgeStaleEpochCaches("user-1", 2)).toBe(2);

    setCacheIdentity("user-1", 0);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m0" })).toBeNull();
    setCacheIdentity("user-1", 1);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m1" })).toBeNull();
    setCacheIdentity("user-1", 2);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "m2" })).toEqual({
      epoch: 2,
    });
    setCacheIdentity("user-2", 0);
    expect(await cacheGet({ workspaceId: "w1", kind: "memory", id: "other" })).toEqual({
      epoch: 0,
    });

    const userRoots = await readdir(path.join(tmpRoot, "users"));
    expect(userRoots).toHaveLength(2);
  });
});
