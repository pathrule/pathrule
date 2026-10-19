// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceSummary,
  latestActivity,
  normalizeFavorites,
  WORKSPACE_FAVORITES_MAX,
} from "./workspace-summary.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");

describe("a workspace at a glance", () => {
  it("has 30 days of deliveries, the window before, and its latest activity", () => {
    const summary = buildWorkspaceSummary(
      {
        id: "w1",
        items: { memory: 3, rule: 2, skill: 1 },
        latestChangeAt: "2026-10-10T08:00:00Z",
        latestActivityAt: "2026-10-12T09:30:00Z",
        deliveryCounts: [
          { day: "2026-10-14", kind: "memory", id: "m1", count: 4 },
          { day: "2026-10-14", kind: "rule", id: "r1", count: 1 },
          { day: "2026-09-15", kind: "memory", id: "m1", count: 2 },
          // The window before: 2026-08-16 to 2026-09-14.
          { day: "2026-09-14", kind: "skill", id: "s1", count: 5 },
          { day: "2026-08-16", kind: "memory", id: "m1", count: 1 },
          { day: "2026-08-15", kind: "memory", id: "m1", count: 9 },
        ],
        activeSignals: 2,
      },
      NOW,
    );
    expect(summary.deliveries).toHaveLength(30);
    expect(summary.deliveries[0]).toBe(2);
    expect(summary.deliveries[29]).toBe(5);
    expect(summary.deliveries.reduce((a, b) => a + b, 0)).toBe(7);
    expect(summary.previousDeliveries).toBe(6);
    // Today's deliveries count from the start of the day, after the activity two days ago.
    expect(summary.lastActivityAt).toBe("2026-10-14T00:00:00.000Z");
    expect(summary).toMatchObject({
      id: "w1",
      items: { memory: 3, rule: 2, skill: 1 },
      activeSignals: 2,
    });
  });

  it("has no latest activity when nothing happened", () => {
    const summary = buildWorkspaceSummary(
      { id: "w", items: { memory: 0, rule: 0, skill: 0 }, deliveryCounts: [], activeSignals: null },
      NOW,
    );
    expect(summary.lastActivityAt).toBeNull();
    expect(summary.deliveries.every((n) => n === 0)).toBe(true);
  });

  it("takes the newest valid time", () => {
    expect(latestActivity([null, "nope", "2026-01-02T00:00:00Z", undefined, "2026-01-01"])).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(latestActivity([])).toBeNull();
  });
});

describe("favorites as kept", () => {
  it("are unique ids in order, at most the limit", () => {
    expect(normalizeFavorites(["a", "b", "a", 3, "", "c"])).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: WORKSPACE_FAVORITES_MAX + 5 }, (_, i) => `w${i}`);
    expect(normalizeFavorites(many)).toHaveLength(WORKSPACE_FAVORITES_MAX);
  });
});
