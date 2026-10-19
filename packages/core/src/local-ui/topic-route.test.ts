// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KnowledgeMapInput } from "../backend/knowledge-map-input.js";
import type { TopicNameCache, TopicNamer } from "../knowledge-map/topic-names.js";
import {
  knowledgeTopics,
  resetTopicNaming,
  TOPIC_NAMING_COOLDOWN_MS,
  TopicsUnavailableError,
  type TopicNames,
} from "./topic-route.js";

// Three tight groups of four memories each, sharing words and linking to each other.
function input(workspaceId: string): KnowledgeMapInput {
  const groups = [
    ["deploy", "release", "staging", "rollback"],
    ["stripe", "billing", "invoice", "webhook"],
    ["tokens", "console", "design", "components"],
  ];
  const items = groups.flatMap((words, g) =>
    words.map((word, i) => ({
      id: `${g}-${i}`,
      kind: (i === 0 && g === 0 ? "rule" : "memory") as "rule" | "memory",
      title: `${words.join(" ")} note ${word}`,
      description: null,
      body: `${words.join(" ")} ${words.join(" ")} [[${words[(i + 1) % words.length]}]]`,
      nodePaths: [`/area${g}`],
      updatedAt: "2026-10-01T00:00:00.000Z",
    })),
  );
  return {
    workspaceId,
    items,
    neighbours: [],
    semantic: "lexical",
    usage: null,
    usageWindowDays: null,
  };
}

function store(fingerprint: string | null = "fp-1") {
  return {
    buildKnowledgeMapInput: vi.fn(async (workspaceId: string) => input(workspaceId)),
    knowledgeMapFingerprint: vi.fn(async () => fingerprint),
  };
}

function names(namer: TopicNamer | null): TopicNames & { saved: TopicNameCache } {
  const kept = { saved: {} as TopicNameCache };
  return Object.assign(kept, {
    namer,
    offReason: "connect a model",
    read: async () => kept.saved,
    write: async (_ws: string, cache: TopicNameCache) => {
      kept.saved = cache;
    },
  });
}

function namer(answer: (ids: string[]) => Promise<Record<string, string>>): TopicNamer & {
  calls: number;
} {
  const n = {
    model: "test/model",
    calls: 0,
    name: async (topics: readonly { id: string }[]) => {
      n.calls += 1;
      return answer(topics.map((t) => t.id));
    },
  };
  return n;
}

afterEach(() => resetTopicNaming());

describe("knowledge topics", () => {
  it("group linked, alike items without any model, and say how to get names", async () => {
    const result = await knowledgeTopics(store(), "ws-a", names(null));
    expect(result.status).toBe("ready");
    expect(result.naming).toEqual({ status: "off", reason: "connect a model" });
    expect(result.topics.length).toBeGreaterThanOrEqual(1);
    for (const topic of result.topics) {
      expect(topic.name).toBeNull();
      expect(topic.terms.length).toBeGreaterThan(0);
      expect(topic.items.every((item) => item.kind === "memory" || item.kind === "rule")).toBe(
        true,
      );
    }
  });

  it("are named once, and the next read asks the model nothing", async () => {
    const model = namer(async (ids) => Object.fromEntries(ids.map((id) => [id, `Name ${id}`])));
    const kept = names(model);
    const first = await knowledgeTopics(store(), "ws-b", kept);
    expect(first.naming).toEqual({ status: "named", model: "test/model" });
    expect(first.topics.every((topic) => topic.name === `Name ${topic.id}`)).toBe(true);
    const second = await knowledgeTopics(store(), "ws-b", kept);
    expect(second.topics.map((t) => t.name)).toEqual(first.topics.map((t) => t.name));
    expect(model.calls).toBe(1);
  });

  it("answer with words while a slow model works, then with its names", async () => {
    let finish: (value: Record<string, string>) => void = () => {};
    const model = namer(() => new Promise((resolve) => (finish = resolve)));
    const kept = names(model);
    const waiting = await knowledgeTopics(store(), "ws-c", kept, { waitMs: 10 });
    expect(waiting.naming.status).toBe("pending");
    expect(waiting.topics.every((topic) => topic.name === null)).toBe(true);
    finish(Object.fromEntries(waiting.topics.map((t) => [t.id, "Later"])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = await knowledgeTopics(store(), "ws-c", kept, { waitMs: 10 });
    expect(later.topics.every((topic) => topic.name === "Later")).toBe(true);
    expect(model.calls).toBe(1);
  });

  it("say a model failed, and leave it alone for a while", async () => {
    const model = namer(async () => {
      throw new Error("The model answered HTTP 529.");
    });
    const kept = names(model);
    const now = Date.parse("2026-10-14T10:00:00Z");
    const failed = await knowledgeTopics(store(), "ws-d", kept, { now });
    expect(failed.naming).toEqual({
      status: "failed",
      model: "test/model",
      reason: "The model answered HTTP 529.",
    });
    await knowledgeTopics(store(), "ws-d", kept, { now: now + 1000 });
    expect(model.calls).toBe(1);
    await knowledgeTopics(store(), "ws-d", kept, { now: now + TOPIC_NAMING_COOLDOWN_MS + 1 });
    expect(model.calls).toBe(2);
  });

  it("are empty for a workspace with no knowledge, and unavailable without a map", async () => {
    expect(await knowledgeTopics(store(null), "ws-e", null)).toMatchObject({
      status: "ready",
      topics: [],
      conventions: [],
    });
    await expect(knowledgeTopics({}, "ws-e", null)).rejects.toBeInstanceOf(TopicsUnavailableError);
  });
});
