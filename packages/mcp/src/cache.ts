// SPDX-License-Identifier: Apache-2.0
// Read-through TTL cache under
// ~/.pathrule/cache/users/<hash(user_id)>/epoch-<N>/<workspace_id>/<kind>/<id>.json
//
// Every tool that reads knowledge goes through this first. On miss, the
// tool fetches fresh and writes the result here. On write tool calls, the
// wrapper invalidates the relevant entries so next reads fetch fresh.
//
// The cache itself does not subscribe to anything — stale reads across team
// members for up to DEFAULT_TTL_MS are acceptable. Under an account, the
// account edition's realtime subscription invalidates entries sooner.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_TTL_MS = 60_000;

interface CacheIdentity {
  userId: string;
  securityEpoch: number;
}

let cacheIdentity: CacheIdentity | null = null;

/**
 * Resolve the cache root lazily so tests can point it at a temp dir via
 * `PATHRULE_CACHE_ROOT`. In production the env is never set and we fall back
 * to `~/.pathrule/cache/` like the spec says.
 */
function cacheRoot(): string {
  return process.env.PATHRULE_CACHE_ROOT ?? join(homedir(), ".pathrule", "cache");
}

export type CacheKind =
  | "tree"
  | "node"
  | "context"
  | "memory"
  | "memory-list"
  | "rule"
  | "skill"
  | "route";

export interface CacheKey {
  workspaceId: string;
  kind: CacheKind;
  id: string;
}

function safeId(raw: string): string {
  // Replace anything outside filename-safe chars with underscore.
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function userCacheRoot(userId: string): string {
  return join(cacheRoot(), "users", hashUserId(userId));
}

export function setCacheIdentity(userId: string, securityEpoch: number): void {
  cacheIdentity = {
    userId,
    securityEpoch: Math.max(0, Math.trunc(securityEpoch)),
  };
}

export function clearCacheIdentity(): void {
  cacheIdentity = null;
}

function pathFor(key: CacheKey): string {
  const identity = cacheIdentity ?? { userId: "unknown", securityEpoch: 0 };
  return join(
    cacheRoot(),
    "users",
    hashUserId(identity.userId),
    `epoch-${identity.securityEpoch}`,
    key.workspaceId,
    key.kind,
    `${safeId(key.id)}.json`,
  );
}

export async function purgeStaleEpochCaches(userId: string, currentEpoch: number): Promise<number> {
  const epoch = Math.max(0, Math.trunc(currentEpoch));
  let entries: string[];
  try {
    entries = await readdir(userCacheRoot(userId));
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const match = /^epoch-(\d+)$/.exec(entry);
    if (!match) continue;

    const entryEpoch = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(entryEpoch) || entryEpoch >= epoch) continue;

    try {
      await rm(join(userCacheRoot(userId), entry), { recursive: true, force: true });
      removed++;
    } catch {
      // Best-effort: cache cleanup must never break a tool call.
    }
  }

  return removed;
}

export async function cacheGet<T>(key: CacheKey, ttlMs = DEFAULT_TTL_MS): Promise<T | null> {
  const p = pathFor(key);
  try {
    const s = await stat(p);
    if (Date.now() - s.mtimeMs > ttlMs) return null;
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cachePut<T>(key: CacheKey, value: T): Promise<void> {
  const p = pathFor(key);
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(value), "utf8");
  } catch {
    // Best-effort — never break a tool call because caching fails.
  }
}

export async function cacheInvalidate(key: CacheKey): Promise<void> {
  try {
    await unlink(pathFor(key));
  } catch {
    // Already gone is fine.
  }
}

/**
 * Drop EVERY entry of a kind for a workspace by removing its
 * directory (e.g. all per-path `context/*.json`). This is the real "_all"
 * fallback: the per-key `id: "_all"` form never matched the per-path/per-id
 * entries the tools actually write. Use for structural changes (node
 * create/delete/move) where the whole dependency graph shifts; per-item
 * changes invalidate a single `cacheInvalidate` key instead.
 */
export async function cacheInvalidateKind(args: {
  workspaceId: string;
  kind: CacheKind;
}): Promise<void> {
  const identity = cacheIdentity ?? { userId: "unknown", securityEpoch: 0 };
  const dir = join(
    cacheRoot(),
    "users",
    hashUserId(identity.userId),
    `epoch-${identity.securityEpoch}`,
    args.workspaceId,
    args.kind,
  );
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — never break a tool call because cache cleanup failed.
  }
}
