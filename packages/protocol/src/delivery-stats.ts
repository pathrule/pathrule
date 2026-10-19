// SPDX-License-Identifier: Apache-2.0
/**
 * Delivery statistics: how often a workspace's knowledge reached agent sessions, by UTC day.
 *
 * One delivery is one memory, rule or skill of the workspace's own knowledge confirmed into one
 * session, counted once on the day it first arrived there, whatever re-sent it later (an edit, a
 * context reset, an explicit read, a second channel). Protocol framing, profiles, guidance and a
 * person's or team's own knowledge are not workspace knowledge and are not counted.
 *
 * Local derives these from the session ledgers (./session-delivery.ts) on the machine; Pathrule
 * Cloud from what its clients report for a Cloud workspace. Both answer `deliveries.stats`.
 */
import {
  DELIVERY_STATS_WINDOWS,
  type DeliveryDay,
  type DeliveryItemCount,
  type DeliveryStatsResponse,
  type DeliveryStatsWindow,
  type KnowledgeKind,
} from "./local-ui-api.js";
import { SESSION_DELIVERY_SCHEMA } from "./session-delivery.js";

export interface KnowledgeDelivery {
  kind: KnowledgeKind;
  id: string;
  /** ISO time of the first confirmed delivery into its session. */
  at: string;
}

const KNOWLEDGE_KINDS: ReadonlySet<string> = new Set<KnowledgeKind>(["memory", "rule", "skill"]);
const DAY_MS = 86_400_000;

export function isDeliveryStatsWindow(value: unknown): value is DeliveryStatsWindow {
  return (DELIVERY_STATS_WINDOWS as readonly unknown[]).includes(value);
}

/**
 * The knowledge one session's ledger received: each workspace memory, rule or skill confirmed into
 * it, once, at its first confirmation. Malformed lines are skipped, never fatal.
 */
export function sessionKnowledgeDeliveries(lines: readonly string[]): KnowledgeDelivery[] {
  const first = new Map<string, KnowledgeDelivery>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const r = record as {
      v?: unknown;
      type?: unknown;
      at?: unknown;
      status?: unknown;
      item?: { kind?: unknown; id?: unknown; scope?: unknown };
    };
    if (r.v !== SESSION_DELIVERY_SCHEMA || r.type !== "receipt" || r.status !== "confirmed")
      continue;
    const kind = r.item?.kind;
    const id = r.item?.id;
    if (typeof kind !== "string" || !KNOWLEDGE_KINDS.has(kind) || typeof id !== "string") continue;
    if (r.item?.scope !== undefined && r.item.scope !== "project") continue;
    if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
    const key = `${kind}:${id}`;
    const prior = first.get(key);
    if (!prior || Date.parse(r.at) < Date.parse(prior.at)) {
      first.set(key, { kind: kind as KnowledgeKind, id, at: r.at });
    }
  }
  return [...first.values()];
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Deliveries of one item on one UTC day: what Pathrule Cloud stores and clients report. */
export interface DeliveryCount {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  kind: KnowledgeKind;
  id: string;
  count: number;
}

/** Deliveries summed per UTC day and item. */
export function countDeliveriesByDay(deliveries: Iterable<KnowledgeDelivery>): DeliveryCount[] {
  const counts = new Map<string, DeliveryCount>();
  for (const delivery of deliveries) {
    const time = Date.parse(delivery.at);
    if (!Number.isFinite(time)) continue;
    const day = utcDay(time);
    const key = `${day}|${delivery.kind}:${delivery.id}`;
    const entry = counts.get(key) ?? { day, kind: delivery.kind, id: delivery.id, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}

/**
 * Deliveries in the `days` UTC days ending today, by day and kind, each item's count there and in
 * the window before, from per-day counts. `recordedSince` is the start of the earliest day seen.
 */
export function buildDeliveryStatsFromCounts(
  counts: Iterable<DeliveryCount>,
  days: DeliveryStatsWindow,
  now: number,
): DeliveryStatsResponse {
  const today = utcDay(now);
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  const start = utcDay(todayStart - (days - 1) * DAY_MS);
  const previousStart = utcDay(todayStart - (2 * days - 1) * DAY_MS);
  const byDay = new Map<string, DeliveryDay>();
  for (let index = 0; index < days; index += 1) {
    const date = utcDay(Date.parse(`${start}T00:00:00Z`) + index * DAY_MS);
    byDay.set(date, { date, memory: 0, rule: 0, skill: 0 });
  }
  const items = new Map<string, DeliveryItemCount>();
  let previousTotal = 0;
  let earliest: string | null = null;
  for (const entry of counts) {
    if (entry.count <= 0 || entry.day < previousStart || entry.day > today) continue;
    if (!KNOWLEDGE_KINDS.has(entry.kind)) continue;
    if (earliest === null || entry.day < earliest) earliest = entry.day;
    const key = `${entry.kind}:${entry.id}`;
    const item = items.get(key) ?? { kind: entry.kind, id: entry.id, count: 0, previous: 0 };
    if (entry.day >= start) {
      item.count += entry.count;
      const day = byDay.get(entry.day);
      if (day) day[entry.kind] += entry.count;
    } else {
      item.previous += entry.count;
      previousTotal += entry.count;
    }
    items.set(key, item);
  }
  return {
    days: [...byDay.values()],
    previousTotal,
    items: [...items.values()].sort((a, b) => b.count - a.count || b.previous - a.previous),
    recordedSince: earliest === null ? null : `${earliest}T00:00:00.000Z`,
  };
}

/**
 * Deliveries in the `days` UTC days ending today, by day and kind, each item's count there and in
 * the window before, and the earliest delivery seen (in either window).
 */
export function buildDeliveryStats(
  deliveries: Iterable<KnowledgeDelivery>,
  days: DeliveryStatsWindow,
  now: number,
): DeliveryStatsResponse {
  const list = [...deliveries];
  const stats = buildDeliveryStatsFromCounts(countDeliveriesByDay(list), days, now);
  const windowStart = Date.parse(`${utcDay(now)}T00:00:00Z`) - (2 * days - 1) * DAY_MS;
  const windowEnd = Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS;
  let earliest: number | null = null;
  for (const delivery of list) {
    const time = Date.parse(delivery.at);
    if (!Number.isFinite(time) || time < windowStart || time >= windowEnd) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return { ...stats, recordedSince: earliest === null ? null : new Date(earliest).toISOString() };
}
