// SPDX-License-Identifier: Apache-2.0
import type { KnowledgeListItem } from "@pathrule/protocol/local-ui-api.js";
import { describe, expect, it } from "vitest";
import {
  CONVENTIONS,
  groupItems,
  inScope,
  matchesQuery,
  pageOf,
  pathTree,
  relatedItems,
  sortItems,
  topicIndex,
  visibleNodes,
} from "../src/knowledge/model.js";

function item(
  id: string,
  path: string | null,
  extra: Partial<KnowledgeListItem> = {},
): KnowledgeListItem {
  return {
    id,
    kind: "memory",
    title: `Item ${id}`,
    preview: "",
    path,
    updatedAt: "2026-10-01T00:00:00.000Z",
    versionNumber: 1,
    ...extra,
  };
}

const items = [
  item("a", "/packages/ui"),
  item("b", "/packages/ui/src"),
  item("c", "/packages/cli"),
  item("d", "/docs"),
  item("e", null),
];

const topics = topicIndex({
  status: "ready",
  topics: [
    {
      id: "rg_1",
      name: null,
      terms: ["ui", "tokens"],
      homePath: "/packages/ui",
      items: [
        { kind: "memory", id: "a" },
        { kind: "memory", id: "b" },
      ],
    },
  ],
  conventions: [{ kind: "memory", id: "d" }],
  naming: { status: "off", reason: "no model" },
});

describe("the path tree", () => {
  it("holds every folder with knowledge and its ancestors, counted with what is under it", () => {
    const tree = pathTree(items);
    expect(tree.map((n) => [n.path, n.count])).toEqual([
      ["/", 4],
      ["/docs", 1],
      ["/packages", 3],
      ["/packages/cli", 1],
      ["/packages/ui", 2],
      ["/packages/ui/src", 1],
    ]);
    // Only the root's children show until a folder is opened.
    expect(visibleNodes(tree, new Set()).map((n) => n.path)).toEqual(["/", "/docs", "/packages"]);
    expect(visibleNodes(tree, new Set(["/packages"])).map((n) => n.path)).toEqual([
      "/",
      "/docs",
      "/packages",
      "/packages/cli",
      "/packages/ui",
    ]);
  });
});

describe("scopes, search and groups", () => {
  it("keep a folder and what is under it, or a topic, or the conventions", () => {
    const keep = (browse: "paths" | "topics", scope: string | null) =>
      items.filter((i) => inScope(i, browse, scope, topics)).map((i) => i.id);
    expect(keep("paths", "/packages/ui")).toEqual(["a", "b"]);
    expect(keep("paths", "/packages/u")).toEqual([]);
    expect(keep("paths", null)).toHaveLength(5);
    expect(keep("topics", "rg_1")).toEqual(["a", "b"]);
    expect(keep("topics", CONVENTIONS)).toEqual(["d"]);
  });

  it("find by any word of the title, path or topic", () => {
    expect(matchesQuery(items[0]!, "tokens ui", topics)).toBe(true);
    expect(matchesQuery(items[2]!, "tokens", topics)).toBe(false);
    expect(matchesQuery(items[2]!, "CLI", topics)).toBe(true);
  });

  it("group by topic with the topicless last, and sort by deliveries", () => {
    const delivered = new Map([
      ["memory:c", 9],
      ["memory:a", 3],
    ]);
    const groups = groupItems(
      sortItems(items, "delivered", delivered),
      "topics",
      topics,
      delivered,
    );
    expect(groups.map((g) => [g.kind, g.label, g.items.map((i) => i.id)])).toEqual([
      ["topic", "ui · tokens", ["a", "b"]],
      ["conventions", "", ["d"]],
      ["none", "", ["c", "e"]],
    ]);
    expect(groups[0]!.delivered).toBe(3);
  });

  it("relate an item to its topic first, then its folder", () => {
    const more = [...items, item("f", "/packages/ui")];
    expect(relatedItems(more[0]!, more, topics).map((r) => [r.item.id, r.why])).toEqual([
      ["b", "topic"],
      ["f", "path"],
    ]);
  });

  it("page groups and clamp a page past the end", () => {
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual({ slice: [3, 4], page: 2, pageCount: 3 });
    expect(pageOf([1, 2], 9, 2).page).toBe(1);
  });
});

describe("the rail", () => {
  it("labels an unnamed topic by its meaningful words, else by its home folder", async () => {
    const { topicLabel } = await import("../src/knowledge/model.js");
    expect(topicLabel(["open", "core", "the"], "/")).toBe("open · core");
    expect(topicLabel(["the", "is", "project"], "/packages/core")).toBe("project");
    expect(topicLabel(["a", "is", "an"], "/packages")).toBe("packages");
    expect(topicLabel(["ui", "tokens"], "/packages/ui")).toBe("ui · tokens");
  });

  it("lists eight children of a folder, then how many more, and finds folders by a filter", async () => {
    const { pathTree, treeRows } = await import("../src/knowledge/model.js");
    const items = Array.from({ length: 12 }, (_, i) => ({
      path: `/packages/p${String(i).padStart(2, "0")}`,
    }));
    const nodes = pathTree(items as never);
    const rows = treeRows(nodes, new Set(["/packages"]), new Set());
    expect(
      rows.filter((row) => row.kind === "node").map((row) => row.kind === "node" && row.node.path),
    ).toEqual(["/", "/packages", ...Array.from({ length: 8 }, (_, i) => `/packages/p0${i}`)]);
    expect(rows.at(-1)).toEqual({ kind: "more", parent: "/packages", depth: 2, hidden: 4 });
    // Opened, every child shows.
    expect(treeRows(nodes, new Set(["/packages"]), new Set(["/packages"]))).toHaveLength(14);
    // A filter finds a folder however deep, with its ancestors.
    expect(
      treeRows(nodes, new Set(), new Set(), "p11").map(
        (row) => row.kind === "node" && row.node.path,
      ),
    ).toEqual(["/", "/packages", "/packages/p11"]);
  });
});
