// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildDeliveryStats,
  isDeliveryStatsWindow,
  sessionKnowledgeDeliveries,
} from "./delivery-stats.js";

const receipt = (fields: Record<string, unknown>) =>
  JSON.stringify({
    v: 1,
    type: "receipt",
    workspace_id: "ws",
    session_id: "s",
    epoch: 0,
    channel: "hook",
    provenance: { source: "hook-index" },
    status: "confirmed",
    ...fields,
  });

describe("delivery statistics", () => {
  it("counts each workspace item once per session, at its first confirmed delivery", () => {
    const lines = [
      receipt({
        at: "2026-10-12T09:00:00Z",
        item: { kind: "memory", id: "m1", hash: "a", scope: "project" },
      }),
      // Re-sent after an edit, a reset and by MCP: still one delivery into this session.
      receipt({
        at: "2026-10-12T10:00:00Z",
        item: { kind: "memory", id: "m1", hash: "b", scope: "project" },
      }),
      receipt({
        at: "2026-10-12T11:00:00Z",
        epoch: 1,
        channel: "mcp",
        item: { kind: "memory", id: "m1", hash: "b", scope: "project" },
      }),
      receipt({
        at: "2026-10-12T08:00:00Z",
        item: { kind: "rule", id: "r1", hash: null, scope: "project" },
      }),
      // Not counted: a failure, framing, a person's own knowledge, garbage.
      receipt({
        at: "2026-10-12T09:00:00Z",
        status: "failed",
        item: { kind: "skill", id: "s1", hash: null, scope: "project" },
      }),
      receipt({
        at: "2026-10-12T09:00:00Z",
        item: { kind: "protocol", id: "pathrule-protocol", hash: null, scope: "project" },
      }),
      receipt({
        at: "2026-10-12T09:00:00Z",
        item: { kind: "memory", id: "p1", hash: null, scope: "user" },
      }),
      "{not json",
      JSON.stringify({ v: 1, type: "epoch", epoch: 1, at: "2026-10-12T10:30:00Z" }),
    ];
    expect(sessionKnowledgeDeliveries(lines)).toEqual([
      { kind: "memory", id: "m1", at: "2026-10-12T09:00:00Z" },
      { kind: "rule", id: "r1", at: "2026-10-12T08:00:00Z" },
    ]);
  });

  it("buckets a window by UTC day, compares with the window before and lists items", () => {
    const now = Date.parse("2026-10-13T15:00:00Z");
    const stats = buildDeliveryStats(
      [
        { kind: "memory", id: "m1", at: "2026-10-13T01:00:00Z" },
        { kind: "memory", id: "m1", at: "2026-10-07T23:59:59Z" }, // first day of a 7-day window
        { kind: "rule", id: "r1", at: "2026-10-12T12:00:00Z" },
        { kind: "memory", id: "m1", at: "2026-10-06T12:00:00Z" }, // the window before
        { kind: "skill", id: "s1", at: "2026-09-30T12:00:00Z" }, // the window before, first day
        { kind: "skill", id: "s1", at: "2026-09-29T23:59:59Z" }, // older: ignored
        { kind: "skill", id: "s1", at: "2026-10-14T00:00:00Z" }, // tomorrow: ignored
      ],
      7,
      now,
    );
    expect(stats.days.map((day) => day.date)).toEqual([
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
    expect(stats.days[0]).toEqual({ date: "2026-10-07", memory: 1, rule: 0, skill: 0 });
    expect(stats.days[5]).toEqual({ date: "2026-10-12", memory: 0, rule: 1, skill: 0 });
    expect(stats.days[6]).toEqual({ date: "2026-10-13", memory: 1, rule: 0, skill: 0 });
    expect(stats.previousTotal).toBe(2);
    expect(stats.items).toEqual([
      { kind: "memory", id: "m1", count: 2, previous: 1 },
      { kind: "rule", id: "r1", count: 1, previous: 0 },
      { kind: "skill", id: "s1", count: 0, previous: 1 },
    ]);
    expect(stats.recordedSince).toBe("2026-09-30T12:00:00.000Z");
  });

  it("answers an empty window with zero days and no first delivery", () => {
    const stats = buildDeliveryStats([], 30, Date.parse("2026-10-13T00:00:00Z"));
    expect(stats.days).toHaveLength(30);
    expect(stats.days.every((day) => day.memory + day.rule + day.skill === 0)).toBe(true);
    expect(stats.recordedSince).toBeNull();
    expect(isDeliveryStatsWindow(30)).toBe(true);
    expect(isDeliveryStatsWindow(14)).toBe(false);
  });
});
