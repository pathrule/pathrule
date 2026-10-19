// SPDX-License-Identifier: Apache-2.0
//
// The knowledge map cache. A map is keyed by (workspace, backend fingerprint,
// algorithm): the same key always means the same map, so a cached one is served without
// rebuilding, and a build that misses its budget keeps running so the next call gets it.
// An error is reported as an error, never as "computing", so an agent does not retry a
// failure forever. No write path ever builds a map; getCachedMap only reads.

import { KNOWLEDGE_MAP_ALGORITHM, type KnowledgeMap } from "./types.js";

export const KNOWLEDGE_MAP_BUDGET_MS = 3_000;
export const KNOWLEDGE_MAP_TTL_MS = 10 * 60_000;
export const KNOWLEDGE_MAP_RETRY_AFTER_MS = 2_000;
const MAX_WORKSPACES = 8;

export type KnowledgeMapLoad =
  | { status: "ready"; map: KnowledgeMap }
  | { status: "computing"; retryAfterMs: number }
  | { status: "error"; error: unknown };

interface Entry {
  fingerprint: string;
  map: KnowledgeMap;
  builtAt: number;
}

const ready = new Map<string, Entry>();
const running = new Map<string, Promise<KnowledgeMap>>();

export function knowledgeMapCacheKey(workspaceId: string, fingerprint: string): string {
  return `${workspaceId}:${fingerprint}:${KNOWLEDGE_MAP_ALGORITHM}`;
}

function remember(workspaceId: string, entry: Entry): void {
  ready.delete(workspaceId);
  ready.set(workspaceId, entry);
  while (ready.size > MAX_WORKSPACES) ready.delete(ready.keys().next().value!);
}

function start(workspaceId: string, fingerprint: string, build: () => Promise<KnowledgeMap>): Promise<KnowledgeMap> {
  const key = knowledgeMapCacheKey(workspaceId, fingerprint);
  let job = running.get(key);
  if (!job) {
    job = build().then((map) => {
      remember(workspaceId, { fingerprint, map, builtAt: Date.now() });
      return map;
    });
    const settled = job;
    running.set(key, settled);
    void settled
      .finally(() => {
        if (running.get(key) === settled) running.delete(key);
      })
      .catch(() => {});
  }
  return job;
}

export async function loadKnowledgeMap(args: {
  workspaceId: string;
  fingerprint: string;
  build: () => Promise<KnowledgeMap>;
  budgetMs?: number;
  now?: () => number;
}): Promise<KnowledgeMapLoad> {
  const now = args.now ?? Date.now;
  const hit = ready.get(args.workspaceId);
  if (hit && hit.fingerprint === args.fingerprint) {
    // Same fingerprint, so the items are the same; past the TTL only usage counts may have
    // moved. Serve it and refresh behind the caller.
    if (now() - hit.builtAt > KNOWLEDGE_MAP_TTL_MS) void start(args.workspaceId, args.fingerprint, args.build).catch(() => {});
    return { status: "ready", map: hit.map };
  }
  const job = start(args.workspaceId, args.fingerprint, args.build);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), args.budgetMs ?? KNOWLEDGE_MAP_BUDGET_MS);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([job, timeout]);
    return result === "timeout" ? { status: "computing", retryAfterMs: KNOWLEDGE_MAP_RETRY_AFTER_MS } : { status: "ready", map: result };
  } catch (error) {
    return { status: "error", error };
  } finally {
    clearTimeout(timer);
  }
}

/** The newest map built for a workspace, whatever its fingerprint. Never builds (Phase 5). */
export function getCachedMap(workspaceId: string): KnowledgeMap | null {
  return ready.get(workspaceId)?.map ?? null;
}

export function clearKnowledgeMapCache(): void {
  ready.clear();
  running.clear();
}
