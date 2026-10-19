// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { LOCAL_VECTOR_CAP, vectorNeighbours } from "./knowledge-map-store.js";

const WS = "ws-map";

// Deterministic 4-dim vectors: texts that share a topic word point the same way.
const TOPICS = ["invoice", "glyph", "replay", "theme"];
function stubEmbed(text: string) {
  const embedding = TOPICS.map((topic) => (text.toLowerCase().includes(topic) ? 1 : 0.05));
  return Promise.resolve({ embedding, model: "stub", dims: embedding.length });
}

async function seeded(): Promise<LocalBackend> {
  const backend = new LocalBackend(":memory:", { embed: stubEmbed });
  const billing = await backend.ensureNodeForPath(WS, "/packages/billing");
  const editor = await backend.ensureNodeForPath(WS, "/packages/editor");
  await backend.writeMemory({ workspaceId: WS, id: "m1", nodeId: billing.id, title: "Invoice retries", content: "invoice retry policy" });
  await backend.writeMemory({ workspaceId: WS, id: "m2", nodeId: billing.id, title: "Invoice refunds", content: "invoice refund flow" });
  await backend.writeMemory({ workspaceId: WS, id: "m3", nodeId: editor.id, title: "Glyph cache", content: "glyph cache eviction" });
  await backend.writeRule({ workspaceId: WS, id: "r1", nodeId: billing.id, name: "Never double charge", content: "Check the invoice id.", scopeType: "folder" });
  await backend.writeSkill({ workspaceId: WS, id: "s1", nodeId: editor.id, name: "font-audit", content: "Audit glyphs.", description: "How to audit fonts" });
  return backend;
}

describe("LocalBackend knowledge map input", () => {
  it("returns live items with node paths, local vector neighbours and no usage", async () => {
    const backend = await seeded();
    try {
      const input = (await backend.buildKnowledgeMapInput(WS))!;
      expect(input.items.map((item) => [item.id, item.kind, item.nodePaths])).toEqual([
        ["m1", "memory", ["/packages/billing"]],
        ["m2", "memory", ["/packages/billing"]],
        ["m3", "memory", ["/packages/editor"]],
        ["r1", "rule", ["/packages/billing"]],
        ["s1", "skill", ["/packages/editor"]],
      ]);
      expect(input.items.find((item) => item.id === "s1")!.description).toBe("How to audit fonts");
      expect(input.semantic).toBe("local");
      expect(input.neighbours.find(([a]) => a === "m1")?.[1]).toBe("m2");
      expect(input.usage).toBeNull();
    } finally {
      backend.close();
    }
  });

  it("drops a deleted memory and changes the fingerprint on edit, delete and attachment moves", async () => {
    const backend = await seeded();
    try {
      const first = await backend.knowledgeMapFingerprint(WS);
      expect(await backend.knowledgeMapFingerprint(WS)).toBe(first);
      await backend.updateMemory({ id: "m1", content: "invoice retry policy, revised" });
      const edited = await backend.knowledgeMapFingerprint(WS);
      expect(edited).not.toBe(first);
      const editor = await backend.ensureNodeForPath(WS, "/packages/editor");
      await backend.updateRule({ id: "r1", nodeId: editor.id });
      const moved = await backend.knowledgeMapFingerprint(WS);
      expect(moved).not.toBe(edited);
      await backend.deleteMemory({ id: "m2" });
      expect(await backend.knowledgeMapFingerprint(WS)).not.toBe(moved);
      expect((await backend.buildKnowledgeMapInput(WS))!.items.map((item) => item.id)).not.toContain("m2");
    } finally {
      backend.close();
    }
  });

  it("falls back to lexical without vectors", async () => {
    const backend = new LocalBackend(":memory:", { embed: async () => null });
    try {
      const node = await backend.ensureNodeForPath(WS, "/x");
      await backend.writeMemory({ workspaceId: WS, nodeId: node.id, title: "A", content: "a" });
      const input = (await backend.buildKnowledgeMapInput(WS))!;
      expect(input.semantic).toBe("lexical");
      expect(input.neighbours).toEqual([]);
    } finally {
      backend.close();
    }
  });
});

describe("vectorNeighbours", () => {
  it("ranks exact cosine top-k within the most common dimension and skips other sizes", () => {
    const v = (...xs: number[]) => Float32Array.from(xs);
    const out = vectorNeighbours([
      { id: "a", vector: v(1, 0) },
      { id: "b", vector: v(0.9, 0.1) },
      { id: "c", vector: v(0, 1) },
      { id: "odd", vector: v(1, 0, 0) },
    ], 1);
    expect(out).toEqual([
      ["a", "b", expect.closeTo(0.9939, 3)],
      ["b", "a", expect.closeTo(0.9939, 3)],
      ["c", "b", expect.closeTo(0.1104, 3)],
    ]);
  });

  it("never pairs vectors of two spaces, even at one dimension", () => {
    const v = (...xs: number[]) => Float32Array.from(xs);
    const out = vectorNeighbours([
      { id: "a", vector: v(1, 0), space: "local/m@2#v1" },
      { id: "b", vector: v(0.9, 0.1), space: "local/m@2#v1" },
      { id: "c", vector: v(1, 0.01), space: "voyage/voyage-3-large@2#v1" },
    ], 2);
    expect(out.map(([a, b]) => `${a}-${b}`)).toEqual(["a-b", "b-a"]);
  });

  it("returns nothing past the cap instead of a quadratic stall", () => {
    const many = Array.from({ length: LOCAL_VECTOR_CAP + 1 }, (_, i) => ({ id: `m${i}`, vector: Float32Array.from([1, i]) }));
    expect(vectorNeighbours(many)).toEqual([]);
  });
});
