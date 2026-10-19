// SPDX-License-Identifier: Apache-2.0
// The memory write handlers carry a memory's context links and its version guard to the backend.
// Before this, `related_paths` stopped at the MCP tool (stored by the cloud extension or nowhere),
// and an update decided from one read was written without that read's version, so a change that
// landed in between was silently overwritten.

import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeBackend } from "../backend/in-memory-backend.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";
import { updateMemoryHandler, writeMemoryHandler } from "./memories.js";
import type { ToolContext } from "./types.js";

const WS = "ws-1";

function ctxFor(backend: KnowledgeBackend): ToolContext {
  return { backend, userId: "tester", workspaceId: WS };
}

async function linkedAt(b: KnowledgeBackend, path: string, id: string): Promise<boolean> {
  return (await b.relevantMemoriesForPath(WS, path)).some(
    (r) => r.memory_id === id && r.via === "context_link",
  );
}

describe("memory handlers: related_paths", () => {
  it("write stores the canonical links and reports them", async () => {
    const b = new InMemoryKnowledgeBackend();
    const res = await writeMemoryHandler(ctxFor(b), {
      node_path: "/api",
      title: "Error envelope",
      content: "x",
      related_paths: ["web/ui/", "/api", "/web/ui"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.relatedPaths).toEqual(["/web/ui"]);
    expect(await linkedAt(b, "/web/ui/Button.tsx", res.data.id)).toBe(true);
  });

  it("an invalid link list is invalid_args, and the path is not materialised", async () => {
    const b = new InMemoryKnowledgeBackend();
    const res = await writeMemoryHandler(ctxFor(b), {
      node_path: "/brand/new/place",
      title: "t",
      content: "c",
      related_paths: ["/"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_args");
    expect(await b.closestNode(WS, "/brand/new/place")).toBeNull();
    expect(await b.listMemories({ workspaceId: WS })).toHaveLength(0);
  });

  it("update: a links-only change is an update; omitted keeps them; [] clears them", async () => {
    const b = new InMemoryKnowledgeBackend();
    const w = await writeMemoryHandler(ctxFor(b), {
      node_path: "/api",
      title: "t",
      content: "c",
      related_paths: ["/web"],
    });
    if (!w.ok) throw new Error(w.error.message);
    const id = w.data.id;

    const linksOnly = await updateMemoryHandler(ctxFor(b), {
      memory_id: id,
      related_paths: ["/docs"],
    });
    expect(linksOnly.ok).toBe(true);
    if (!linksOnly.ok) return;
    expect(linksOnly.data.relatedPaths).toEqual(["/docs"]);
    expect(linksOnly.data.content).toBe("c");
    expect(await linkedAt(b, "/docs", id)).toBe(true);
    expect(await linkedAt(b, "/web", id)).toBe(false);

    const kept = await updateMemoryHandler(ctxFor(b), { memory_id: id, title: "t2" });
    expect(kept.ok && kept.data.relatedPaths).toBe(undefined);
    expect(await linkedAt(b, "/docs", id)).toBe(true);

    const cleared = await updateMemoryHandler(ctxFor(b), { memory_id: id, related_paths: [] });
    expect(cleared.ok && cleared.data.relatedPaths).toEqual([]);
    expect(await linkedAt(b, "/docs", id)).toBe(false);
  });

  it("links are validated against the owner the memory moves to", async () => {
    const b = new InMemoryKnowledgeBackend();
    const w = await writeMemoryHandler(ctxFor(b), { node_path: "/api", title: "t", content: "c" });
    if (!w.ok) throw new Error(w.error.message);
    const moved = await updateMemoryHandler(ctxFor(b), {
      memory_id: w.data.id,
      move_to_path: "/web",
      related_paths: ["/web", "/api"],
    });
    expect(moved.ok && moved.data.relatedPaths).toEqual(["/api"]);
  });
});

describe("memory handlers: the version guard reaches the backend", () => {
  /**
   * A backend where another writer lands between the handler's read and its write: the first
   * `updateMemory` is preceded by a concurrent edit, exactly the window a content_edit is exposed in.
   */
  function racingBackend(inner: InMemoryKnowledgeBackend): KnowledgeBackend {
    let raced = false;
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "updateMemory") {
          return async (input: Parameters<KnowledgeBackend["updateMemory"]>[0]) => {
            if (!raced) {
              raced = true;
              await target.updateMemory({ id: input.id, content: "edited by someone else" });
            }
            return target.updateMemory(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as KnowledgeBackend;
  }

  it("a content_edit decided from a read that went stale is a conflict, not an overwrite", async () => {
    const inner = new InMemoryKnowledgeBackend();
    const w = await writeMemoryHandler(ctxFor(inner), {
      node_path: "/api",
      title: "t",
      content: "original body",
    });
    if (!w.ok) throw new Error(w.error.message);

    const res = await updateMemoryHandler(ctxFor(racingBackend(inner)), {
      memory_id: w.data.id,
      content_edit: { op: "append", text: "\nmore" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("conflict");
    const current = await inner.readMemory(w.data.id);
    expect(current?.content).toBe("edited by someone else");
    expect(res.error.detail).toEqual({ current_version_id: current?.versionId });
  });

  it("a caller's own expected_version_id is the guard the backend applies", async () => {
    const inner = new InMemoryKnowledgeBackend();
    const w = await writeMemoryHandler(ctxFor(inner), {
      node_path: "/api",
      title: "t",
      content: "c",
    });
    if (!w.ok) throw new Error(w.error.message);
    const res = await updateMemoryHandler(ctxFor(racingBackend(inner)), {
      memory_id: w.data.id,
      content: "mine",
      expected_version_id: w.data.versionId,
      related_paths: ["/web"],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("conflict");
    expect(await linkedAt(inner, "/web", w.data.id)).toBe(false);
  });
});
