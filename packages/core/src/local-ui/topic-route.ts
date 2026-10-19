// SPDX-License-Identifier: Apache-2.0
// `knowledge.topics` for both consoles: the knowledge map's regions (packages/core/src/knowledge-map)
// as topics, each with its items, named by a model when the backend has one. The map needs no
// model and is cached by the backend's fingerprint; names are kept by the backend (`TopicNames`) per
// region and its terms, so a model is asked only about regions it has not named yet, a batch at a
// time, and a failing model is not asked again for a while.
import type {
  KnowledgeRef,
  KnowledgeTopic,
  KnowledgeTopicsResponse,
  TopicNaming,
} from "@pathrule/protocol/local-ui-api.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";
import { buildKnowledgeMap } from "../knowledge-map/build.js";
import { loadKnowledgeMap } from "../knowledge-map/cache.js";
import {
  mergeTopicNames,
  topicName,
  topicsToName,
  type TopicNameCache,
  type TopicNamer,
  type TopicNameRequest,
} from "../knowledge-map/topic-names.js";
import type { KnowledgeMap } from "../knowledge-map/types.js";

export type TopicStore = Pick<
  KnowledgeBackend,
  "buildKnowledgeMapInput" | "knowledgeMapFingerprint"
>;

/** Where a backend keeps names, and the model that makes them (null: none connected). */
export interface TopicNames {
  namer: TopicNamer | null;
  /** Why topics carry no names when there is no model, e.g. how to connect one. */
  offReason: string;
  read(workspaceId: string): Promise<TopicNameCache>;
  write(workspaceId: string, cache: TopicNameCache): Promise<void>;
}

/** How long a read waits for names before answering with the terms ("pending"). */
export const TOPIC_NAMING_WAIT_MS = 8_000;
/** How long a model that failed is left alone before it is asked again. */
export const TOPIC_NAMING_COOLDOWN_MS = 5 * 60_000;
const MAP_BUDGET_MS = 5_000;
const TITLES = 6;

const naming = new Map<string, Promise<void>>();
const failures = new Map<string, { at: number; reason: string }>();

export class TopicsUnavailableError extends Error {}

function topicRequests(map: KnowledgeMap): TopicNameRequest[] {
  return map.regions.map((region) => ({
    id: region.id,
    terms: region.terms,
    homePath: region.homePath,
    titles: [region.anchorId, ...region.memberIds.filter((id) => id !== region.anchorId)]
      .slice(0, TITLES)
      .map((id) => map.items[id]?.title ?? "")
      .filter(Boolean),
  }));
}

function refs(map: KnowledgeMap, ids: readonly string[]): KnowledgeRef[] {
  return ids.flatMap((id) => {
    const item = map.items[id];
    return item ? [{ kind: item.kind, id }] : [];
  });
}

/** Names the regions the cache lacks, once per workspace at a time, within `waitMs`. */
async function name(
  workspaceId: string,
  requests: readonly TopicNameRequest[],
  names: TopicNames & { namer: TopicNamer },
  now: number,
  waitMs: number,
): Promise<{ cache: TopicNameCache; naming: TopicNaming }> {
  const model = names.namer.model;
  let cache = await names.read(workspaceId).catch(() => ({}) as TopicNameCache);
  if (topicsToName(requests, cache, model).length === 0) {
    return { cache, naming: { status: "named", model } };
  }
  const failed = failures.get(workspaceId);
  if (failed && now - failed.at < TOPIC_NAMING_COOLDOWN_MS) {
    return { cache, naming: { status: "failed", model, reason: failed.reason } };
  }
  let job = naming.get(workspaceId);
  if (!job) {
    const missing = topicsToName(requests, cache, model);
    job = names.namer
      .name(missing)
      .then(async (named) => {
        const latest = await names.read(workspaceId).catch(() => ({}) as TopicNameCache);
        await names.write(workspaceId, mergeTopicNames(latest, requests, named, model));
        failures.delete(workspaceId);
      })
      .finally(() => naming.delete(workspaceId));
    naming.set(workspaceId, job);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Promise<"waiting">((resolve) => {
    timer = setTimeout(() => resolve("waiting"), waitMs);
  });
  const outcome = await Promise.race([
    job.then(
      () => "done" as const,
      (error: unknown) => error,
    ),
    waiting,
  ]);
  clearTimeout(timer);
  if (outcome === "waiting") return { cache, naming: { status: "pending", model } };
  if (outcome !== "done") {
    const reason =
      outcome instanceof Error ? outcome.message : "The model could not name the topics.";
    failures.set(workspaceId, { at: now, reason });
    return { cache, naming: { status: "failed", model, reason } };
  }
  cache = await names.read(workspaceId).catch(() => cache);
  return {
    cache,
    naming: {
      status: topicsToName(requests, cache, model).length === 0 ? "named" : "pending",
      model,
    },
  };
}

/** The workspace's topics, largest first; throws TopicsUnavailableError on a store without a map. */
export async function knowledgeTopics(
  store: TopicStore,
  workspaceId: string,
  names: TopicNames | null,
  options: { now?: number; waitMs?: number } = {},
): Promise<KnowledgeTopicsResponse> {
  if (!store.buildKnowledgeMapInput || !store.knowledgeMapFingerprint) {
    throw new TopicsUnavailableError("This backend does not build a knowledge map.");
  }
  const off: TopicNaming = names?.namer
    ? { status: "named", model: names.namer.model }
    : { status: "off", reason: names?.offReason ?? "No model is connected to name topics." };
  const fingerprint = await store.knowledgeMapFingerprint(workspaceId);
  if (!fingerprint) return { status: "ready", topics: [], conventions: [], naming: off };
  const buildInput = store.buildKnowledgeMapInput.bind(store);
  const load = await loadKnowledgeMap({
    workspaceId,
    fingerprint,
    budgetMs: MAP_BUDGET_MS,
    build: async () => {
      const input = await buildInput(workspaceId);
      if (!input) throw new Error("The backend returned no knowledge map input.");
      return buildKnowledgeMap(input, { fingerprint, generatedAt: new Date().toISOString() });
    },
  });
  if (load.status === "computing") {
    return {
      status: "computing",
      retryAfterMs: load.retryAfterMs,
      topics: [],
      conventions: [],
      naming: off.status === "off" ? off : { status: "pending", model: off.model },
    };
  }
  if (load.status === "error") throw load.error;
  const map = load.map;
  const requests = topicRequests(map);
  const named =
    names?.namer && requests.length > 0
      ? await name(
          workspaceId,
          requests,
          names as TopicNames & { namer: TopicNamer },
          options.now ?? Date.now(),
          options.waitMs ?? TOPIC_NAMING_WAIT_MS,
        )
      : { cache: {} as TopicNameCache, naming: off };
  const topics: KnowledgeTopic[] = map.regions
    .map((region, index) => ({
      id: region.id,
      name: topicName(requests[index]!, named.cache),
      terms: region.terms,
      homePath: region.homePath,
      items: refs(map, region.memberIds),
    }))
    .sort((a, b) => b.items.length - a.items.length || a.id.localeCompare(b.id));
  return {
    status: "ready",
    topics,
    conventions: refs(map, map.conventions),
    naming: named.naming,
  };
}

/** For tests: forget names in flight and failures. */
export function resetTopicNaming(): void {
  naming.clear();
  failures.clear();
}
