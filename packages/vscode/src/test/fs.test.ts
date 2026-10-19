// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { KnowledgeBackend } from "@pathrule/core";

import { ContentStore } from "../fs/content-store.js";
import { contentUriParts, parseContentUri, slugify } from "../fs/uri.js";

describe("pathrule:// uri", () => {
  it("round-trips a content ref", () => {
    const parts = contentUriParts(
      { workspaceId: "ws-1", kind: "memory", id: "abc" },
      "Checkout conventions (v2)",
    );
    expect(parts.path).toBe("/memory/abc/checkout-conventions-v2.md");
    expect(parseContentUri(parts.authority, parts.path)).toEqual({
      workspaceId: "ws-1",
      kind: "memory",
      id: "abc",
    });
  });

  it("rejects unknown kinds and malformed paths", () => {
    expect(parseContentUri("ws", "/bogus/id/x.md")).toBeNull();
    expect(parseContentUri("", "/memory/id/x.md")).toBeNull();
    expect(parseContentUri("ws", "/memory")).toBeNull();
  });

  it("slugify is filesystem-safe and never empty", () => {
    expect(slugify("Ünïcode — çok güzel!")).toBe("unicode-cok-guzel");
    expect(slugify("///")).toBe("untitled");
  });
});

interface FakeMemory {
  id: string;
  title: string;
  content: string;
  versionId: string;
}

function fakeBackend(memory: FakeMemory): KnowledgeBackend {
  const state = { memory };
  return {
    readMemory: async (id: string) =>
      id === state.memory.id
        ? ({ ...state.memory, workspaceId: "ws", nodeId: "n" } as never)
        : null,
    updateMemory: async (input: { id: string; content?: string }) => {
      state.memory = {
        ...state.memory,
        content: input.content ?? state.memory.content,
        versionId: `v${Number(state.memory.versionId.slice(1)) + 1}`,
      };
      return { ...state.memory, workspaceId: "ws", nodeId: "n" } as never;
    },
    // Test double — only the methods ContentStore touches are real.
  } as unknown as KnowledgeBackend;
}

describe("ContentStore concurrency", () => {
  const ref = { workspaceId: "ws", kind: "memory" as const, id: "m1" };

  it("read caches the version; clean save bumps it", async () => {
    const backend = fakeBackend({ id: "m1", title: "t", content: "a", versionId: "v1" });
    const store = new ContentStore(() => backend);
    const doc = await store.read(ref);
    expect(doc?.versionId).toBe("v1");
    const result = await store.save(ref, "b");
    expect(result).toEqual({ status: "saved", versionId: "v2" });
  });

  it("remote change between read and save → conflict, nothing written", async () => {
    const backend = fakeBackend({ id: "m1", title: "t", content: "a", versionId: "v1" });
    const store = new ContentStore(() => backend);
    await store.read(ref);
    // Remote edit happens behind our back:
    await backend.updateMemory({ id: "m1", content: "remote" });
    const result = await store.save(ref, "mine");
    expect(result.status).toBe("conflict");
    expect((await backend.readMemory("m1"))?.content).toBe("remote");
  });

  it("invalidate() accepts the server state on next read (Reload)", async () => {
    const backend = fakeBackend({ id: "m1", title: "t", content: "a", versionId: "v1" });
    const store = new ContentStore(() => backend);
    await store.read(ref);
    await backend.updateMemory({ id: "m1", content: "remote" });
    store.invalidate(ref);
    const doc = await store.read(ref);
    expect(doc?.body).toBe("remote");
    const result = await store.save(ref, "mine-after-reload");
    expect(result.status).toBe("saved");
  });

  it("unbound workspace → missing", async () => {
    const store = new ContentStore(() => null);
    expect(await store.save(ref, "x")).toEqual({ status: "missing" });
  });
});
