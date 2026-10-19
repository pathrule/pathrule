// SPDX-License-Identifier: Apache-2.0
// The knowledge browser: the tree of paths with subtree totals, what a path holds (nearest first),
// the filter, the keys, bodies read on demand, and stored text that can never drive the terminal.
import { describe, expect, it } from "vitest";

import { parseKeys, type Key } from "../terminal/keys.js";
import { terminalStyle } from "../terminal/style.js";
import { stripAnsi, visibleWidth } from "../terminal/text.js";
import {
  bodyLines,
  browserKey,
  buildTree,
  filtered,
  initialBrowserState,
  itemsUnder,
  renderBrowser,
  runBrowser,
  visibleRows,
  type BrowserContext,
  type Previews,
} from "./browser.js";
import type { KnowledgeEntry, KnowledgeReader } from "./knowledge.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const ENTRIES: KnowledgeEntry[] = [
  { kind: "memory", id: "m1", title: "Workspace overview", path: "/" },
  { kind: "rule", id: "r1", title: "No em dashes", path: "/", priority: "high" },
  { kind: "memory", id: "m2", title: "The CLI is open", path: "/packages/cli" },
  { kind: "memory", id: "m3", title: "The terminal home", path: "/packages/cli/src/home" },
  { kind: "skill", id: "s1", title: "pathrule-release-cli", path: "/packages/cli" },
  { kind: "memory", id: "m4", title: "Host owns the stores", path: "/packages/host" },
];

function context(columns = 110, rows = 32, color = true, unicode = true): BrowserContext {
  return {
    style: terminalStyle({ color, unicode, depth: "256", tone: "light" }),
    columns,
    rows,
    now: NOW,
    workspace: "pathrule",
  };
}

const key = (text: string): Key => parseKeys(text)[0]!;

describe("the knowledge tree", () => {
  it("holds every path with an item and its ancestors, each with its subtree total", () => {
    const tree = buildTree(ENTRIES);
    expect(tree.get("/")!.total).toBe(6);
    expect(tree.get("/packages")!.total).toBe(4);
    expect(tree.get("/packages/cli")!.total).toBe(3);
    expect(tree.get("/packages/cli/src")!.children).toEqual(["/packages/cli/src/home"]);
  });

  it("shows only expanded nodes' children", () => {
    const tree = buildTree(ENTRIES);
    expect(visibleRows(tree, new Set(["/"])).map((r) => r.path)).toEqual(["/", "/packages"]);
    expect(visibleRows(tree, new Set(["/", "/packages"])).map((r) => r.path)).toEqual([
      "/",
      "/packages",
      "/packages/cli",
      "/packages/host",
    ]);
  });

  it("lists what a path holds, its own items first, rules before memories before skills", () => {
    expect(itemsUnder(ENTRIES, "/packages/cli").map((e) => e.id)).toEqual(["m2", "s1", "m3"]);
    expect(
      itemsUnder(ENTRIES, "/")
        .slice(0, 2)
        .map((e) => e.id),
    ).toEqual(["r1", "m1"]);
  });

  it("filters by title or path, in any case", () => {
    expect(filtered(ENTRIES, "HOME").map((e) => e.id)).toEqual(["m3"]);
    expect(filtered(ENTRIES, "packages/host").map((e) => e.id)).toEqual(["m4"]);
    expect(filtered(ENTRIES, "  ")).toHaveLength(6);
  });
});

describe("the browser screen", () => {
  for (const [columns, rows] of [
    [80, 22],
    [110, 32],
    [160, 50],
  ] as const) {
    it(`fills ${columns}×${rows} exactly, in colour or not`, () => {
      for (const ctx of [context(columns, rows), context(columns, rows, false, false)]) {
        const state = initialBrowserState(ENTRIES);
        const lines = renderBrowser(ENTRIES, state, new Map(), ctx);
        expect(lines).toHaveLength(rows);
        expect(lines.filter((l) => visibleWidth(l) > columns).map(stripAnsi)).toEqual([]);
      }
    });
  }

  it("previews the selected item with its kind, path and age, and its body", () => {
    const state = initialBrowserState(ENTRIES);
    state.path = "/packages/cli";
    state.focus = "items";
    const previews: Previews = new Map([
      [
        "memory:m2",
        {
          entry: ENTRIES[2]!,
          body: "## Routing\nBare pathrule opens the home.",
          updatedAt: "2026-10-09T12:00:00Z",
        },
      ],
    ]);
    const text = stripAnsi(renderBrowser(ENTRIES, state, previews, context()).join("\n"));
    expect(text).toContain("The CLI is open");
    expect(text).toContain("memory · /packages/cli · updated 24 h ago");
    expect(text).toContain("Routing");
    expect(text).toContain("Bare pathrule opens the home.");
  });

  it("prints stored text without any escape sequence it carries", () => {
    const hostile =
      "Title\x1b]0;owned\x07 then\x1b[2J\x1b[H clear\x1b]8;;https://evil.example\x1b\\link\x1b]8;;\x1b\\ \x9b31m bell\x07";
    const lines = bodyLines(hostile, 80, terminalStyle({ color: false, unicode: true }));
    const out = lines.join("\n");
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(out).toBe("Title then clearlink bell");
  });
});

describe("the browser's keys", () => {
  it("moves through the tree, opens a path, reads an item and comes back", () => {
    const state = initialBrowserState(ENTRIES);
    expect(browserKey(key("\x1b[B"), state, ENTRIES, 20)).toBe("stay"); // down: /packages
    expect(state.path).toBe("/packages");
    browserKey(key("\x1b[B"), state, ENTRIES, 20); // down: /packages/cli
    expect(state.path).toBe("/packages/cli");
    browserKey(key("\x1b[C"), state, ENTRIES, 20); // right: expand cli
    expect(state.expanded.has("/packages/cli")).toBe(true);
    browserKey(key("\x1b[C"), state, ENTRIES, 20); // right again: into its items
    expect(state.focus).toBe("items");
    browserKey(key("\x1b[B"), state, ENTRIES, 20);
    expect(state.item).toBe(1);
    browserKey(key("\r"), state, ENTRIES, 20); // read
    expect(state.reading).toBe(0);
    browserKey(key(" "), state, ENTRIES, 20); // a page down
    expect(state.reading).toBe(18);
    browserKey(key("\x1b"), state, ENTRIES, 20); // back to the list
    expect(state.reading).toBeNull();
    browserKey(key("\x1b"), state, ENTRIES, 20); // back to the tree
    expect(state.focus).toBe("tree");
    expect(browserKey(key("\x1b"), state, ENTRIES, 20)).toBe("leave");
  });

  it("filters as the person types, clears on Esc, and leaves on q or Ctrl-C", () => {
    const state = initialBrowserState(ENTRIES);
    browserKey(key("/"), state, ENTRIES, 20);
    expect(state.typing).toBe(true);
    for (const char of "host") browserKey(key(char), state, ENTRIES, 20);
    expect(state.filter).toBe("host");
    expect(browserKey(key("q"), state, ENTRIES, 20)).toBe("stay"); // typed, not a key
    expect(state.filter).toBe("hostq");
    browserKey({ name: "backspace" }, state, ENTRIES, 20);
    browserKey(key("\r"), state, ENTRIES, 20);
    expect(state).toMatchObject({ typing: false, filter: "host" });
    browserKey(key("/"), state, ENTRIES, 20);
    browserKey(key("\x1b"), state, ENTRIES, 20);
    expect(state).toMatchObject({ typing: false, filter: "" });
    expect(browserKey(key("q"), state, ENTRIES, 20)).toBe("leave");
    expect(browserKey({ name: "interrupt" }, initialBrowserState(ENTRIES), ENTRIES, 20)).toBe(
      "leave",
    );
  });
});

describe("runBrowser", () => {
  it("reads a body only when its item is shown, once, and says when one cannot be read", async () => {
    const reads: string[] = [];
    const reader: KnowledgeReader = {
      entries: ENTRIES,
      async read(entry) {
        reads.push(entry.id);
        if (entry.id === "m1") throw new Error("the store is busy");
        return { entry, body: `Body of ${entry.title}`, updatedAt: null };
      },
      async close() {},
    };
    const frames: string[] = [];
    const script = ["\t", "\x1b[B", "\x1b[A", "q"].map(key);
    await runBrowser(reader, {
      draw: (lines) => frames.push(stripAnsi(lines.join("\n"))),
      key: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return script.shift() ?? { name: "interrupt" };
      },
      context: () => context(),
    });
    // The root's first item (the rule), then the memory under it, then back: read once each.
    expect(reads).toEqual(["r1", "m1"]);
    expect(frames.some((f) => f.includes("Body of No em dashes"))).toBe(true);
    expect(frames.some((f) => f.includes("could not be read: the store is busy"))).toBe(true);
  });
});
