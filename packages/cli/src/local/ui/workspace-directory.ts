// SPDX-License-Identifier: Apache-2.0
// The Local Console's Workspaces page: every local workspace at a glance (`workspaces.summary`) and
// this machine's favorites (`workspaces.favorite`). A glance is read through the host like every
// other route, with deliveries from this machine's session ledgers. Favorites live in the Pathrule
// home (`<home>/console-favorites.json`, 0600), never in the browser and never in an account.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { KnowledgeBackend } from "@pathrule/core/backend/knowledge-backend.js";
import { withFileLock } from "@pathrule/core/storage/file-lock.js";
import {
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
  pathruleHome,
} from "@pathrule/core/storage/paths.js";
import { readWorkspaceKnowledgeDeliveries } from "@pathrule/integrations/native/delivery-ledger.js";
import { countDeliveriesByDay } from "@pathrule/protocol/delivery-stats.js";
import {
  WORKSPACE_SUMMARY_DAYS,
  type WorkspaceActivitySummary,
} from "@pathrule/protocol/local-ui-api.js";
import {
  buildWorkspaceSummary,
  latestActivity,
  normalizeFavorites,
  WORKSPACE_FAVORITES_MAX,
} from "@pathrule/protocol/workspace-summary.js";

const DAY_MS = 86_400_000;
/** Workspaces read at once: a home may hold many, and each glance asks the host several things. */
const GLANCE_CONCURRENCY = 4;
const FAVORITES_LOCK = { timeoutMs: 10_000, staleMs: 10_000 } as const;

export type GlanceStore = Pick<
  KnowledgeBackend,
  "listMemories" | "listRules" | "listSkills" | "recentActivities" | "runtimeEventStatus"
>;

/** One workspace at a glance, from its store and this machine's session ledgers. */
export async function glanceWorkspace(
  store: GlanceStore,
  workspaceId: string,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<WorkspaceActivitySummary> {
  const since = now - 2 * WORKSPACE_SUMMARY_DAYS * DAY_MS;
  const [memories, rules, skills, activity, deliveries, activeSignals] = await Promise.all([
    store.listMemories({ workspaceId, status: "active" }),
    store.listRules({ workspaceId, status: "active" }),
    store.listSkills({ workspaceId, status: "active" }),
    store.recentActivities({ workspaceId, relativePath: "" }, 1),
    readWorkspaceKnowledgeDeliveries(workspaceId, since, env),
    // A host older than runtime events cannot tell; the page shows nothing rather than zero.
    store.runtimeEventStatus
      ? store.runtimeEventStatus(workspaceId).then(
          (status) => status.activeCount,
          () => null,
        )
      : Promise.resolve(null),
  ]);
  return buildWorkspaceSummary(
    {
      id: workspaceId,
      items: { memory: memories.length, rule: rules.length, skill: skills.length },
      latestChangeAt: latestActivity(
        [...memories, ...rules, ...skills].map((item) => item.updatedAt),
      ),
      latestActivityAt: activity[0]?.createdAt ?? null,
      deliveryCounts: countDeliveriesByDay(deliveries),
      activeSignals,
    },
    now,
  );
}

/** Every workspace's glance, a few at a time, in `ids` order; one that cannot be read is left out. */
export async function glanceWorkspaces(
  ids: readonly string[],
  read: (workspaceId: string) => Promise<WorkspaceActivitySummary>,
): Promise<WorkspaceActivitySummary[]> {
  const results: Array<WorkspaceActivitySummary | null> = new Array(ids.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await read(ids[index]!).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GLANCE_CONCURRENCY, ids.length) }, worker));
  return results.filter((entry): entry is WorkspaceActivitySummary => entry !== null);
}

// ── favorites ────────────────────────────────────────────────────────────────

export function favoritesFile(env: NodeJS.ProcessEnv): string {
  return join(pathruleHome(env), "console-favorites.json");
}

/** This machine's favorites, oldest first; none when the file is missing or unreadable. */
export async function readFavorites(env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(favoritesFile(env), "utf8"));
    const ids = (value as { workspaces?: unknown } | null)?.workspaces;
    return Array.isArray(ids) ? normalizeFavorites(ids) : [];
  } catch {
    return [];
  }
}

/** Created 0600 from the first byte, then renamed into place. */
async function writeFavorites(env: NodeJS.ProcessEnv, ids: readonly string[]): Promise<void> {
  const target = favoritesFile(env);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, workspaces: ids }, null, 2)}\n`, {
      mode: PATHRULE_FILE_MODE,
      flag: "wx",
    });
    await chmod(tmp, PATHRULE_FILE_MODE);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export class FavoritesFullError extends Error {
  constructor() {
    super(`At most ${WORKSPACE_FAVORITES_MAX} workspaces can be favorites.`);
  }
}

/**
 * Marks or unmarks one workspace, under a lock so two consoles never lose each other's change.
 * Ids no longer in `known` (a removed workspace) are dropped on the way. Returns the favorites.
 */
export async function setFavorite(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  favorite: boolean,
  known: ReadonlySet<string>,
): Promise<string[]> {
  await mkdir(pathruleHome(env), { recursive: true, mode: PATHRULE_DIR_MODE });
  return withFileLock(
    `${favoritesFile(env)}.lock`,
    async () => {
      const current = (await readFavorites(env)).filter((id) => known.has(id));
      const has = current.includes(workspaceId);
      if (favorite && !has && current.length >= WORKSPACE_FAVORITES_MAX) {
        throw new FavoritesFullError();
      }
      const next = favorite
        ? has
          ? current
          : [...current, workspaceId]
        : current.filter((id) => id !== workspaceId);
      await writeFavorites(env, next);
      return next;
    },
    FAVORITES_LOCK,
  );
}
