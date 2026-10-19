// SPDX-License-Identifier: Apache-2.0
import type { WorkspaceActivitySummary } from "@pathrule/protocol/local-ui-api.js";
import { describe, expect, it } from "vitest";
import {
  activityTone,
  arrange,
  directoryFigures,
  directoryRows,
  matchesQuery,
  shortFolder,
} from "../src/workspaces/model.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const DAY = 86_400_000;

function workspace(id: string, name = id) {
  return { id, name, rootPath: `/home/me/code/${name}`, current: false };
}

function summary(
  id: string,
  ageDays: number | null,
  items = 1,
  delivered = 0,
): WorkspaceActivitySummary {
  return {
    id,
    items: { memory: items, rule: 0, skill: 0 },
    lastActivityAt: ageDays === null ? null : new Date(NOW - ageDays * DAY).toISOString(),
    deliveries: [...new Array<number>(29).fill(0), delivered],
    previousDeliveries: 10,
    activeSignals: null,
  };
}

const names = (page: ReturnType<typeof arrange>) =>
  page.groups.map((group) => group.rows.map((row) => row.workspace.name));

describe("the workspace list", () => {
  const list = ["alpha", "bravo", "charlie", "delta", "echo"].map((name) => workspace(name));
  const summaries = [
    summary("alpha", 40, 5, 1),
    summary("bravo", 0.1, 1, 9),
    summary("charlie", null, 0),
    summary("delta", 3, 8, 4),
    summary("echo", 10, 2, 2),
  ];

  it("puts favorites first, each part in the chosen order", () => {
    const rows = directoryRows(list, summaries, new Set(["echo", "alpha"]));
    expect(names(arrange(rows, { sort: "activity", page: 1, pageSize: 12 }))).toEqual([
      ["echo", "alpha"],
      ["bravo", "delta", "charlie"],
    ]);
    expect(names(arrange(rows, { sort: "items", page: 1, pageSize: 12 }))).toEqual([
      ["alpha", "echo"],
      ["delta", "bravo", "charlie"],
    ]);
    expect(names(arrange(rows, { sort: "deliveries", page: 1, pageSize: 12 }))[1]).toEqual([
      "bravo",
      "delta",
      "charlie",
    ]);
  });

  it("pages the ordered list and clamps a page past the end", () => {
    const rows = directoryRows(list, summaries, new Set(["echo"]));
    const second = arrange(rows, { sort: "name", page: 2, pageSize: 2 });
    expect(second).toMatchObject({ page: 2, pageCount: 3, total: 5, favorites: 1, others: 4 });
    expect(names(second)).toEqual([["bravo", "charlie"]]);
    expect(arrange(rows, { sort: "name", page: 9, pageSize: 2 }).page).toBe(3);
  });

  it("searches names and the line under them", () => {
    expect(matchesQuery("acme-web", "~/code/acme-web", "ACME")).toBe(true);
    expect(matchesQuery("acme-web", "pathrule/site", "site")).toBe(true);
    expect(matchesQuery("acme-web", "~/code", "docs")).toBe(false);
    expect(matchesQuery("anything", "", "  ")).toBe(true);
  });

  it("orders workspaces without a summary last when sorting by activity", () => {
    const rows = directoryRows(list, null, new Set());
    expect(names(arrange(rows, { sort: "activity", page: 1, pageSize: 12 }))).toEqual([
      ["alpha", "bravo", "charlie", "delta", "echo"],
    ]);
  });
});

describe("the figures above the list", () => {
  it("count every workspace, whatever the search", () => {
    const rows = directoryRows(
      [workspace("a"), workspace("b"), workspace("c"), workspace("d")],
      [summary("a", 0.5, 3, 5), summary("b", 5, 2, 1), summary("c", 45, 1), summary("d", 200)],
      new Set(),
    );
    const figures = directoryFigures(rows, NOW);
    expect(figures).toMatchObject({
      count: 4,
      activeThisWeek: 2,
      itemsTotal: 7,
      delivered: 6,
      previous: 40,
      quiet: 2,
      ages: [1, 1, 0, 1, 1],
    });
    expect(figures.deliveries).toHaveLength(30);
    expect(figures.change).toBeCloseTo(-85);
  });
});

describe("activity and folders", () => {
  it("tell recent from quiet", () => {
    expect(activityTone(null, NOW)).toBe("none");
    expect(activityTone(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe("recent");
    expect(activityTone(new Date(NOW - 3 * DAY).toISOString(), NOW)).toBe("week");
    expect(activityTone(new Date(NOW - 20 * DAY).toISOString(), NOW)).toBe("idle");
    expect(activityTone(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe("quiet");
  });

  it("shorten the home folder to ~", () => {
    expect(shortFolder("/home/me/code/x", "/home/me")).toBe("~/code/x");
    expect(shortFolder("/home/me", "/home/me/")).toBe("~");
    expect(shortFolder("/home/meet/x", "/home/me")).toBe("/home/meet/x");
    expect(shortFolder("C:\\Users\\me\\x", "C:\\Users\\me")).toBe("~\\x");
    expect(shortFolder("/srv/x", null)).toBe("/srv/x");
  });
});
