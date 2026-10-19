// SPDX-License-Identifier: Apache-2.0
// The local vector store keeps vector spaces apart: a provider or model switch never compares the
// new space's query with the old space's vectors, even at one dimension, and a bounded, resumable
// reindex moves the memories over without touching the knowledge records.
import { describe, expect, it } from "vitest";

import {
  embeddingSpaceKey,
  type EmbedFn,
  type EmbeddingSpaceFamily,
} from "../embedding-adapter.js";
import { LocalBackend } from "./local-backend.js";

const WS = "ws-space";
const QUERY = {
  workspaceId: WS,
  matchedNodePath: "/",
  bundleMemories: undefined,
  subtreeIndex: undefined,
  discoveryCandidateTitles: undefined,
};

/** A stub provider whose space can be switched, and which can be made to fail. */
function stubProvider(
  initial: Omit<EmbeddingSpaceFamily, "version">,
  options: { minSimilarity?: number } = {},
) {
  const state = {
    family: { ...initial, version: 1 } as EmbeddingSpaceFamily,
    /** Report a bare model name and no space, as a vector stored before spaces were recorded. */
    legacy: false,
    failAfter: Infinity,
    calls: 0,
  };
  const embed: EmbedFn = async (text) => {
    state.calls += 1;
    if (state.calls > state.failAfter) throw new Error("provider unreachable");
    const lower = text.toLowerCase();
    const embedding = lower.includes("weak")
      ? [0.4, 0.9165, 0]
      : ["alpha", "beta", "gamma"].map((t) => (lower.includes(t) ? 1 : 0));
    return {
      embedding,
      model: state.family.model,
      dims: 3,
      ...(state.legacy ? {} : { space: embeddingSpaceKey(state.family, 3) }),
      ...(options.minSimilarity === undefined ? {} : { minSimilarity: options.minSimilarity }),
    };
  };
  return { state, embed, family: () => state.family };
}

function backendWith(provider: ReturnType<typeof stubProvider>): LocalBackend {
  let n = 0;
  return new LocalBackend(":memory:", {
    genId: () => `id-${String(++n).padStart(3, "0")}`,
    embed: provider.embed,
    embeddingSpace: provider.family,
  });
}

const candidateIds = async (backend: LocalBackend, userIntent: string) =>
  (await backend.semanticCandidates({ ...QUERY, userIntent }))?.payload?.candidates.map(
    (c) => c.id,
  ) ?? [];

describe("LocalBackend vector spaces", () => {
  it("never compares two spaces of one dimension, and reindex moves memories to the new one", async () => {
    const provider = stubProvider({ provider: "local", model: "qwen3-embedding:0.6b" });
    const backend = backendWith(provider);
    const alpha = await backend.writeMemory({
      workspaceId: WS,
      title: "alpha",
      content: "all about alpha",
    });
    expect(await candidateIds(backend, "alpha")).toEqual([alpha.id]);
    expect(await backend.embeddingSpace(WS)).toBe("local/qwen3-embedding:0.6b@3#v1");

    // Same dimension, another model: the old vector is not compared and not shipped to the hook.
    provider.state.family = {
      provider: "cloudflare",
      model: "@cf/qwen/qwen3-embedding-0.6b",
      version: 1,
    };
    expect(await candidateIds(backend, "alpha")).toEqual([]);
    expect(await backend.buildEmbeddingsPayload(WS)).toBeNull();
    expect(await backend.embeddingSpace(WS)).toBeNull();
    expect(await backend.embeddingCoverage(WS)).toMatchObject({
      memories: 1,
      current: 0,
      stale: 1,
      missing: 0,
      space: null,
      family: "cloudflare/@cf/qwen/qwen3-embedding-0.6b#v1",
    });

    const step = await backend.reindexEmbeddings(WS);
    expect(step).toMatchObject({ reembedded: 1, failed: 0, remaining: 0, stopped: "done" });
    expect(step.space).toBe("cloudflare/@cf/qwen/qwen3-embedding-0.6b@3#v1");
    expect(await candidateIds(backend, "alpha")).toEqual([alpha.id]);
    expect(Object.keys((await backend.buildEmbeddingsPayload(WS)) ?? {})).toEqual([alpha.id]);
    expect(await backend.embeddingSpace(WS)).toBe(step.space);
  });

  it("emits only the current space's vectors, skills included", async () => {
    const provider = stubProvider({ provider: "voyage", model: "voyage-3-large" });
    const backend = backendWith(provider);
    const old = await backend.writeMemory({ workspaceId: WS, title: "alpha", content: "alpha" });
    provider.state.family = { provider: "openai", model: "text-embedding-3-large", version: 1 };
    const fresh = await backend.writeMemory({ workspaceId: WS, title: "beta", content: "beta" });
    const skill = await backend.writeSkill({
      workspaceId: WS,
      name: "gamma skill",
      content: "gamma",
    });
    const payload = (await backend.buildEmbeddingsPayload(WS)) ?? {};
    expect(Object.keys(payload).sort()).toEqual([fresh.id, skill.id].sort());
    expect(payload[old.id]).toBeUndefined();
  });

  it("uses a vector stored before spaces were recorded only where its model name is unambiguous", async () => {
    const provider = stubProvider({ provider: "voyage", model: "voyage-3-large" });
    provider.state.legacy = true;
    const backend = backendWith(provider);
    const alpha = await backend.writeMemory({
      workspaceId: WS,
      title: "alpha",
      content: "all about alpha",
    });
    provider.state.legacy = false;
    // The bare "voyage-3-large" row can only be Voyage's: it counts in that space.
    expect(await candidateIds(backend, "alpha")).toEqual([alpha.id]);
    expect(await backend.embeddingCoverage(WS)).toMatchObject({ current: 1, stale: 0 });
    // Another provider with a model of the same name is another space.
    provider.state.family = { provider: "local", model: "voyage-3-large", version: 1 };
    expect(await candidateIds(backend, "alpha")).toEqual([]);
    expect(await backend.embeddingCoverage(WS)).toMatchObject({ current: 0, stale: 1 });
  });

  it("re-embeds in bounded, resumable steps and leaves the knowledge records as they were", async () => {
    const provider = stubProvider({ provider: "local", model: "nomic-embed-text" });
    const backend = backendWith(provider);
    const memories = [];
    for (const title of [
      "alpha one",
      "alpha two",
      "beta one",
      "beta two",
      "gamma one",
      "gamma two",
    ]) {
      memories.push(await backend.writeMemory({ workspaceId: WS, title, content: title }));
    }
    const before = await Promise.all(memories.map((m) => backend.readMemory(m.id)));
    provider.state.family = { provider: "voyage", model: "voyage-3-large", version: 1 };

    // A bounded step: two vectors, and a cursor to go on from.
    const first = await backend.reindexEmbeddings(WS, { limit: 2 });
    expect(first).toMatchObject({
      reembedded: 2,
      remaining: 4,
      stopped: "limit",
      cursor: memories[1]!.id,
    });

    // The provider goes away mid-run: what was written stays, and the run says why it stopped.
    provider.state.calls = 0;
    provider.state.failAfter = 1;
    const interrupted = await backend.reindexEmbeddings(WS, { after: first.cursor! });
    expect(interrupted).toMatchObject({
      reembedded: 1,
      failed: 3,
      remaining: 3,
      stopped: "provider_failure",
    });

    // A fresh run continues where it stopped: only the three left are embedded.
    provider.state.calls = 0;
    provider.state.failAfter = Infinity;
    const rest = await backend.reindexEmbeddings(WS);
    expect(rest).toMatchObject({ reembedded: 3, failed: 0, remaining: 0, stopped: "done" });
    expect(provider.state.calls).toBe(3);
    expect(await backend.embeddingCoverage(WS)).toMatchObject({
      memories: 6,
      current: 6,
      stale: 0,
      missing: 0,
    });

    expect(await Promise.all(memories.map((m) => backend.readMemory(m.id)))).toEqual(before);
  });

  it("stops instead of mixing when the provider answers in another space mid-run", async () => {
    const family = (model: string): EmbeddingSpaceFamily => ({
      provider: "local",
      model,
      version: 1,
    });
    let configured = family("old");
    let answering = family("old");
    const backend = new LocalBackend(":memory:", {
      embed: async () => ({
        embedding: [1, 0, 0],
        model: answering.model,
        dims: 3,
        space: embeddingSpaceKey(answering, 3),
      }),
      embeddingSpace: () => configured,
    });
    await backend.writeMemory({ workspaceId: WS, title: "stale", content: "stale" });
    configured = answering = family("a");
    await backend.writeMemory({ workspaceId: WS, title: "current", content: "current" });
    // The configuration still says "a", whose vectors exist; the provider now answers as "b".
    answering = family("b");
    const step = await backend.reindexEmbeddings(WS);
    expect(step).toMatchObject({
      reembedded: 0,
      remaining: 1,
      stopped: "space_changed",
      space: "local/a@3#v1",
    });
    expect((await backend.embeddingCoverage(WS)).stale).toBe(1);
  });

  it("applies a model's own floor, and moves the confidence tiers with it", async () => {
    // cosine(query, weak doc) = 0.40: below the default 0.45 floor, above a 0.30 model floor.
    const lowScale = stubProvider(
      { provider: "cloudflare", model: "@cf/qwen/qwen3-embedding-0.6b" },
      { minSimilarity: 0.3 },
    );
    const backend = backendWith(lowScale);
    const weak = await backend.writeMemory({ workspaceId: WS, title: "weak", content: "weak" });
    const result = await backend.semanticCandidates({ ...QUERY, userIntent: "alpha" });
    expect(result?.payload?.candidates).toMatchObject([{ id: weak.id, confidence: "medium" }]);
    expect(result?.payload?.searched_scope.min_similarity).toBe(0.3);
    // An explicit caller floor still wins.
    expect(
      await backend.semanticCandidates({ ...QUERY, userIntent: "alpha", minSimilarity: 0.45 }),
    ).toMatchObject({
      skipped: "no_candidates",
    });

    const defaultScale = backendWith(stubProvider({ provider: "voyage", model: "voyage-3-large" }));
    await defaultScale.writeMemory({ workspaceId: WS, title: "weak", content: "weak" });
    expect(await defaultScale.semanticCandidates({ ...QUERY, userIntent: "alpha" })).toMatchObject({
      skipped: "no_candidates",
    });
  });
});
