// SPDX-License-Identifier: Apache-2.0
/**
 * Every workspace at a glance (`workspaces.summary`), built the same way by both backends: Local
 * from the home's stores and this machine's session ledgers, Pathrule Cloud from its own tables.
 *
 * - Deliveries follow ./delivery-stats.ts over `WORKSPACE_SUMMARY_DAYS` days.
 * - The latest activity is the newest of a knowledge change, recorded agent activity and a
 *   delivery; a delivery is known by its UTC day only and counts at that day's start.
 * - Favorites are workspace ids, at most `WORKSPACE_FAVORITES_MAX`, kept by the backend.
 */
import { buildDeliveryStatsFromCounts, type DeliveryCount } from "./delivery-stats.js";
import {
  WORKSPACE_SUMMARY_DAYS,
  type DeliveryStatsResponse,
  type KnowledgeKind,
  type WorkspaceActivitySummary,
} from "./local-ui-api.js";

/** The most favorites one backend keeps for one person (Cloud) or one machine (Local). */
export const WORKSPACE_FAVORITES_MAX = 200;

/** A delivery report as the glance's daily series, the window before, and its last active day. */
export function workspaceDeliveries(stats: DeliveryStatsResponse): {
  deliveries: number[];
  previousDeliveries: number;
  lastDeliveryAt: string | null;
} {
  const deliveries = stats.days.map((day) => day.memory + day.rule + day.skill);
  let last: string | null = null;
  for (const day of stats.days) {
    if (day.memory + day.rule + day.skill > 0) last = day.date;
  }
  return {
    deliveries,
    previousDeliveries: stats.previousTotal,
    lastDeliveryAt: last === null ? null : `${last}T00:00:00.000Z`,
  };
}

/** The newest of these times, or null when none is a valid time. */
export function latestActivity(times: Iterable<string | null | undefined>): string | null {
  let latest: number | null = null;
  for (const time of times) {
    if (!time) continue;
    const value = Date.parse(time);
    if (Number.isFinite(value) && (latest === null || value > latest)) latest = value;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export interface WorkspaceSummaryInput {
  id: string;
  items: Record<KnowledgeKind, number>;
  /** The newest knowledge change and recorded activity, when known. */
  latestChangeAt?: string | null;
  latestActivityAt?: string | null;
  /** Deliveries counted per UTC day and item, covering at least twice the summary window. */
  deliveryCounts: Iterable<DeliveryCount>;
  activeSignals: number | null;
}

/** One workspace's entry, from what its backend counted. */
export function buildWorkspaceSummary(
  input: WorkspaceSummaryInput,
  now: number,
): WorkspaceActivitySummary {
  const totals = workspaceDeliveries(
    buildDeliveryStatsFromCounts(input.deliveryCounts, WORKSPACE_SUMMARY_DAYS, now),
  );
  return {
    id: input.id,
    items: { memory: input.items.memory, rule: input.items.rule, skill: input.items.skill },
    lastActivityAt: latestActivity([
      input.latestChangeAt,
      input.latestActivityAt,
      totals.lastDeliveryAt,
    ]),
    deliveries: totals.deliveries,
    previousDeliveries: totals.previousDeliveries,
    activeSignals: input.activeSignals,
  };
}

/** Favorites as kept: unique ids, oldest first, the newest dropped past the limit. */
export function normalizeFavorites(ids: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > 128) continue;
    if (seen.size >= WORKSPACE_FAVORITES_MAX) break;
    seen.add(id);
  }
  return [...seen];
}
