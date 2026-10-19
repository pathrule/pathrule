// SPDX-License-Identifier: Apache-2.0
import type { DeliveryStatsResponse, KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import type { TreeNode } from "@pathrule/protocol/node-types.js";
import { describe, expect, it } from "vitest";
import {
  ageHistogram,
  coverageByPath,
  deliveriesByItem,
  deliveriesCsv,
  folderCoverage,
  healthBreakdown,
  summarizeDeliveries,
  topKnowledge,
} from "../src/overview/model.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function item(
  id: string,
  kind: KnowledgeListItem["kind"],
  path: string | null,
  editedDaysAgo: number,
): KnowledgeListItem {
  return {
    id,
    kind,
    title: id,
    preview: "",
    path,
    updatedAt: daysAgo(editedDaysAgo),
    versionNumber: 1,
  };
}

const ITEMS = [
  item("m1", "memory", "/src", 2),
  item("m2", "memory", "/src", 120),
  item("m3", "memory", "/docs", 200),
  item("r1", "rule", "/", 10),
  item("s1", "skill", null, 1),
];

const STATS: DeliveryStatsResponse = {
  days: [
    { date: "2026-10-10", memory: 4, rule: 1, skill: 0 }, // Saturday
    { date: "2026-10-11", memory: 0, rule: 0, skill: 0 }, // Sunday
    { date: "2026-10-12", memory: 10, rule: 3, skill: 2 },
  ],
  previousTotal: 10,
  items: [
    { kind: "memory", id: "m1", count: 12, previous: 2 },
    { kind: "memory", id: "m2", count: 2, previous: 6 },
    { kind: "rule", id: "r1", count: 4, previous: 2 },
    { kind: "skill", id: "s1", count: 2, previous: 0 },
    { kind: "memory", id: "gone", count: 9, previous: 0 },
  ],
  recordedSince: "2026-09-01T00:00:00Z",
};

describe("overview model", () => {
  it("assigns one health state per item, delivery-aware when deliveries are known", () => {
    expect(healthBreakdown(ITEMS, deliveriesByItem(STATS), NOW)).toEqual({
      current: 2, // m1 (recent, delivered), r1
      unused: 1, // m3: never delivered
      stale: 1, // m2: edited 120 days ago, still delivered
      unplaced: 1, // s1 has no path, even though delivered
    });
    expect(healthBreakdown(ITEMS, null, NOW)).toEqual({
      current: 2,
      unused: 0,
      stale: 2,
      unplaced: 1,
    });
  });

  it("buckets items by last edit and marks the buckets past 90 days", () => {
    const histogram = ageHistogram(ITEMS, NOW);
    expect(histogram.map((b) => [b.bucket, b.count, b.stale])).toEqual([
      ["week", 2, false],
      ["month", 1, false],
      ["quarter", 0, false],
      ["half", 1, true],
      ["older", 1, true],
    ]);
  });

  it("groups by owner path, busiest first, and measures folder coverage", () => {
    const rows = coverageByPath(ITEMS, deliveriesByItem(STATS));
    expect(rows.map((r) => [r.path, r.total, r.deliveries])).toEqual([
      ["/src", 2, 14],
      ["/", 1, 4],
      ["/docs", 1, 0],
    ]);
    expect(rows[0]!.updatedAt).toBe(daysAgo(2));
    const node = (relativePath: string, status: TreeNode["status"] = "active"): TreeNode => ({
      id: relativePath,
      workspaceId: "ws",
      parentId: null,
      name: relativePath,
      type: "folder",
      relativePath,
      orderIndex: 0,
      status,
      orphanedAt: null,
      originalPath: null,
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
    });
    expect(
      folderCoverage([node(""), node("/src"), node("/lib"), node("/old", "archived")], ITEMS),
    ).toEqual({ covered: 2, total: 3 });
  });

  it("summarizes the window: totals by kind, change, extremes and weekend share", () => {
    const summary = summarizeDeliveries(STATS);
    expect(summary.total).toBe(20);
    expect(summary.byKind).toEqual({ memory: 14, rule: 4, skill: 2 });
    expect(summary.change).toBe(100);
    expect(summary.busiest).toEqual({ date: "2026-10-12", total: 15 });
    expect(summary.quietest).toEqual({ date: "2026-10-11", total: 0 });
    expect(summary.weekendShare).toBe(0.25);
    expect(summarizeDeliveries({ ...STATS, previousTotal: 0 }).change).toBeNull();
  });

  it("ranks the most delivered and the biggest gains among items that still exist", () => {
    expect(topKnowledge(ITEMS, STATS, "delivered").map((r) => [r.item.id, r.value])).toEqual([
      ["m1", 12],
      ["r1", 4],
      ["m2", 2],
      ["s1", 2],
    ]);
    expect(topKnowledge(ITEMS, STATS, "rising").map((r) => [r.item.id, r.value])).toEqual([
      ["m1", 10],
      ["r1", 2],
      ["s1", 2],
    ]);
  });

  it("exports the days newest first", () => {
    expect(deliveriesCsv(STATS).split("\n").slice(0, 2)).toEqual([
      "date,memories,rules,skills,total",
      "2026-10-12,10,3,2,15",
    ]);
  });
});
