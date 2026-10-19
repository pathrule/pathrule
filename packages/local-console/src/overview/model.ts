// SPDX-License-Identifier: Apache-2.0
// The Overview's numbers, computed from what the Local UI API answers: knowledge lists, the
// workspace tree and delivery statistics. Pure functions, so both consoles and the tests agree.
import type {
  DeliveryStatsResponse,
  KnowledgeKind,
  KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";

export const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];

/** Knowledge not edited for this long is stale. */
export const STALE_DAYS = 90;

const DAY_MS = 86_400_000;

export type KindCounts = Record<KnowledgeKind, number>;

export function emptyKindCounts(): KindCounts {
  return { memory: 0, rule: 0, skill: 0 };
}

export function countByKind(items: readonly KnowledgeListItem[]): KindCounts {
  const counts = emptyKindCounts();
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

function ageDays(iso: string, now: number): number {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? (now - time) / DAY_MS : 0;
}

function itemKey(kind: KnowledgeKind, id: string): string {
  return `${kind}:${id}`;
}

/** Deliveries per item in the stats window, keyed `kind:id`. */
export function deliveriesByItem(stats: DeliveryStatsResponse): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of stats.items) map.set(itemKey(item.kind, item.id), item.count);
  return map;
}

/* ── Knowledge health ────────────────────────────────────────────────────── */

/**
 * One state per item, the first that applies: no path; not delivered in the window (needs
 * delivery data); not edited for STALE_DAYS (with delivery data: and still delivered); current.
 */
export type HealthState = "current" | "unused" | "stale" | "unplaced";

export const HEALTH_STATES: readonly HealthState[] = ["current", "unused", "stale", "unplaced"];

export function healthOf(
  item: KnowledgeListItem,
  delivered: ReadonlyMap<string, number> | null,
  now: number,
): HealthState {
  if (!item.path) return "unplaced";
  if (delivered && !delivered.get(itemKey(item.kind, item.id))) return "unused";
  if (ageDays(item.updatedAt, now) >= STALE_DAYS) return "stale";
  return "current";
}

export function healthBreakdown(
  items: readonly KnowledgeListItem[],
  delivered: ReadonlyMap<string, number> | null,
  now: number,
): Record<HealthState, number> {
  const counts: Record<HealthState, number> = { current: 0, unused: 0, stale: 0, unplaced: 0 };
  for (const item of items) counts[healthOf(item, delivered, now)] += 1;
  return counts;
}

/* ── Age of knowledge ────────────────────────────────────────────────────── */

export type AgeBucket = "week" | "month" | "quarter" | "half" | "older";

/** Upper bounds in days, oldest last; the last two buckets are past STALE_DAYS. */
const AGE_BOUNDS: ReadonlyArray<readonly [AgeBucket, number]> = [
  ["week", 7],
  ["month", 28],
  ["quarter", STALE_DAYS],
  ["half", 180],
  ["older", Number.POSITIVE_INFINITY],
];

export function ageHistogram(
  items: readonly KnowledgeListItem[],
  now: number,
): Array<{ bucket: AgeBucket; count: number; stale: boolean }> {
  const counts = new Map<AgeBucket, number>(AGE_BOUNDS.map(([bucket]) => [bucket, 0]));
  for (const item of items) {
    const age = ageDays(item.updatedAt, now);
    const bucket = AGE_BOUNDS.find(([, bound]) => age < bound)?.[0] ?? "older";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return AGE_BOUNDS.map(([bucket, bound]) => ({
    bucket,
    count: counts.get(bucket) ?? 0,
    stale: bound > STALE_DAYS,
  }));
}

/* ── Coverage ────────────────────────────────────────────────────────────── */

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface PathRow {
  path: string;
  counts: KindCounts;
  total: number;
  /** Deliveries in the window, or null without delivery data. */
  deliveries: number | null;
  /** The latest edit of any item at this path. */
  updatedAt: string;
}

/** Knowledge grouped by owner path; busiest first (by deliveries when known, else by size). */
export function coverageByPath(
  items: readonly KnowledgeListItem[],
  delivered: ReadonlyMap<string, number> | null,
): PathRow[] {
  const rows = new Map<string, PathRow>();
  for (const item of items) {
    if (!item.path) continue;
    const path = normalizePath(item.path);
    const row = rows.get(path) ?? {
      path,
      counts: emptyKindCounts(),
      total: 0,
      deliveries: delivered ? 0 : null,
      updatedAt: item.updatedAt,
    };
    row.counts[item.kind] += 1;
    row.total += 1;
    if (delivered && row.deliveries != null)
      row.deliveries += delivered.get(itemKey(item.kind, item.id)) ?? 0;
    if (Date.parse(item.updatedAt) > Date.parse(row.updatedAt)) row.updatedAt = item.updatedAt;
    rows.set(path, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      (b.deliveries ?? 0) - (a.deliveries ?? 0) ||
      b.total - a.total ||
      a.path.localeCompare(b.path),
  );
}

/** Active folders of the workspace tree that own at least one knowledge item. */
export function folderCoverage(
  nodes: readonly TreeNode[],
  items: readonly KnowledgeListItem[],
): { covered: number; total: number } {
  const owned = new Set(items.filter((item) => item.path).map((item) => normalizePath(item.path!)));
  const folders = nodes.filter((node) => node.type === "folder" && node.status === "active");
  const covered = folders.filter((node) => owned.has(normalizePath(node.relativePath))).length;
  return { covered, total: folders.length };
}

/* ── Deliveries ──────────────────────────────────────────────────────────── */

export interface DeliverySummary {
  total: number;
  byKind: KindCounts;
  /** Change against the window before, in percent; null when the window before had none. */
  change: number | null;
  average: number;
  busiest: { date: string; total: number } | null;
  quietest: { date: string; total: number } | null;
  /** Share of deliveries on Saturdays and Sundays, 0–1; null without deliveries. */
  weekendShare: number | null;
}

function dayTotal(day: DeliveryStatsResponse["days"][number]): number {
  return day.memory + day.rule + day.skill;
}

export function summarizeDeliveries(stats: DeliveryStatsResponse): DeliverySummary {
  const byKind = emptyKindCounts();
  let weekend = 0;
  let busiest: DeliverySummary["busiest"] = null;
  let quietest: DeliverySummary["quietest"] = null;
  for (const day of stats.days) {
    for (const kind of KINDS) byKind[kind] += day[kind];
    const total = dayTotal(day);
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) weekend += total;
    if (!busiest || total > busiest.total) busiest = { date: day.date, total };
    if (!quietest || total < quietest.total) quietest = { date: day.date, total };
  }
  const total = byKind.memory + byKind.rule + byKind.skill;
  return {
    total,
    byKind,
    change:
      stats.previousTotal > 0 ? ((total - stats.previousTotal) / stats.previousTotal) * 100 : null,
    average: stats.days.length ? total / stats.days.length : 0,
    busiest: total > 0 ? busiest : null,
    quietest: total > 0 ? quietest : null,
    weekendShare: total > 0 ? weekend / total : null,
  };
}

export type TopMode = "delivered" | "rising";

export interface TopRow {
  item: KnowledgeListItem;
  /** Deliveries in the window ("delivered") or the gain over the window before ("rising"). */
  value: number;
  /** Deliveries in the window. */
  count: number;
}

/** The most delivered items, or the ones that gained the most; only items the lists still hold. */
export function topKnowledge(
  items: readonly KnowledgeListItem[],
  stats: DeliveryStatsResponse,
  mode: TopMode,
  limit = 7,
): TopRow[] {
  const byKey = new Map(items.map((item) => [itemKey(item.kind, item.id), item]));
  const rows: TopRow[] = [];
  for (const entry of stats.items) {
    const item = byKey.get(itemKey(entry.kind, entry.id));
    if (!item) continue;
    const value = mode === "delivered" ? entry.count : entry.count - entry.previous;
    if (value <= 0) continue;
    rows.push({ item, value, count: entry.count });
  }
  return rows.sort((a, b) => b.value - a.value || b.count - a.count).slice(0, limit);
}

/** Daily deliveries as CSV, newest first, for the Export action. */
export function deliveriesCsv(stats: DeliveryStatsResponse): string {
  const lines = ["date,memories,rules,skills,total"];
  for (const day of [...stats.days].reverse())
    lines.push(`${day.date},${day.memory},${day.rule},${day.skill},${dayTotal(day)}`);
  return `${lines.join("\n")}\n`;
}
