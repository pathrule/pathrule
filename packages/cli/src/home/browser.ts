// SPDX-License-Identifier: Apache-2.0
// The knowledge browser of the cockpit: the workspace's paths as a tree, what the selected path
// holds (its own items and those below it), and a preview of the selected item, with a reader for
// the whole body. Read only. `/` filters by title or path.
//
// Bodies are written by agents and people: they are printed through `terminalSafe`, so an escape
// sequence in one cannot move the cursor, retitle the window or forge a link.
import { drawPanel, sideBySide, spread, type PanelTone } from "../terminal/box.js";
import type { Key } from "../terminal/keys.js";
import type { Style } from "../terminal/style.js";
import {
  formatAgo,
  formatCount,
  padEnd,
  terminalSafe,
  truncate,
  visibleWidth,
  wrap,
} from "../terminal/text.js";
import type { KnowledgeEntry, KnowledgeItem, KnowledgeKind, KnowledgeReader } from "./knowledge.js";

export interface BrowserContext {
  style: Style;
  columns: number;
  rows: number;
  now: number;
  /** The workspace's name, for the header. */
  workspace: string;
}

interface TreeNode {
  path: string;
  name: string;
  depth: number;
  /** Items in this node and below it. */
  total: number;
  children: string[];
}

export interface BrowserState {
  focus: "tree" | "items";
  /** The selected path of the tree. */
  path: string;
  item: number;
  expanded: Set<string>;
  filter: string;
  typing: boolean;
  /** The reader's first line, when the whole body is open. */
  reading: number | null;
}

/** What is known about each item's body: read, being read, or why it could not be. */
export type Previews = Map<string, KnowledgeItem | "loading" | { error: string }>;

const KIND_ORDER: Record<KnowledgeKind, number> = { rule: 0, memory: 1, skill: 2 };

export const entryKey = (entry: KnowledgeEntry) => `${entry.kind}:${entry.id}`;

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

const within = (path: string, root: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

/** Entries matching `filter` (title or path, any case); all of them without one. */
export function filtered(entries: readonly KnowledgeEntry[], filter: string): KnowledgeEntry[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (e) => e.title.toLowerCase().includes(needle) || e.path.toLowerCase().includes(needle),
  );
}

/** The tree of every path that holds an item, with each node's subtree total. */
export function buildTree(entries: readonly KnowledgeEntry[]): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  const ensure = (path: string): TreeNode => {
    let node = nodes.get(path);
    if (node) return node;
    const segments = path.split("/").filter(Boolean);
    node = {
      path,
      name: path === "/" ? "/" : segments[segments.length - 1]!,
      depth: segments.length,
      total: 0,
      children: [],
    };
    nodes.set(path, node);
    const parent = parentOf(path);
    if (parent !== null) {
      const up = ensure(parent);
      if (!up.children.includes(path)) up.children.push(path);
    }
    return node;
  };
  ensure("/");
  for (const entry of entries) {
    for (let path: string | null = entry.path; path !== null; path = parentOf(path)) {
      ensure(path).total += 1;
    }
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.localeCompare(b));
  return nodes;
}

/** The tree's rows in order, with only expanded nodes' children. */
export function visibleRows(
  tree: Map<string, TreeNode>,
  expanded: ReadonlySet<string>,
): TreeNode[] {
  const rows: TreeNode[] = [];
  const walk = (path: string) => {
    const node = tree.get(path);
    if (!node) return;
    rows.push(node);
    if (expanded.has(path)) for (const child of node.children) walk(child);
  };
  walk("/");
  return rows;
}

/** The items under `path`, nearest first, then by kind and title. */
export function itemsUnder(entries: readonly KnowledgeEntry[], path: string): KnowledgeEntry[] {
  return entries
    .filter((e) => within(e.path, path))
    .sort(
      (a, b) =>
        a.path.split("/").length - b.path.split("/").length ||
        a.path.localeCompare(b.path) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.title.localeCompare(b.title),
    );
}

export function initialBrowserState(entries: readonly KnowledgeEntry[]): BrowserState {
  const tree = buildTree(entries);
  const expanded = new Set<string>(["/"]);
  for (const child of tree.get("/")?.children ?? []) expanded.add(child);
  return { focus: "tree", path: "/", item: 0, expanded, filter: "", typing: false, reading: null };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function badge(kind: KnowledgeKind, style: Style): string {
  if (kind === "rule") return style.warn("R");
  if (kind === "skill") return style.dim("S");
  return style.accent("M");
}

/** A window of `rows` around `selected`, so the selection stays in view. */
function windowOf<T>(
  list: readonly T[],
  selected: number,
  rows: number,
): { start: number; items: T[] } {
  if (list.length <= rows) return { start: 0, items: [...list] };
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), list.length - rows));
  return { start, items: list.slice(start, start + rows) };
}

/**
 * Markdown's inline emphasis on one display line: **strong** in bold, `code` in the accent. A pair
 * split across two wrapped lines is left as written.
 */
function inline(line: string, style: Style): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_, text: string) => style.strong(text))
    .replace(/`([^`]+)`/g, (_, text: string) => style.accent(text));
}

/** A body as display lines: safe to print, wrapped, headings in the accent. */
export function bodyLines(body: string, width: number, style: Style): string[] {
  const lines: string[] = [];
  for (const raw of terminalSafe(body).replace(/\t/g, "  ").split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(style.accent(style.strong(truncate(heading[1]!, width, style.glyph.ellipsis))));
      continue;
    }
    if (raw.trim() === "") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const indent = /^\s*/.exec(raw)![0].length;
    for (const [i, line] of wrap(raw.trim(), Math.max(10, width - indent)).entries()) {
      const shown = `${" ".repeat(indent)}${i > 0 && /^[-*]\s/.test(raw.trim()) ? "  " : ""}${line}`;
      lines.push(inline(shown, style));
    }
  }
  return lines;
}

function previewLines(
  entry: KnowledgeEntry | undefined,
  previews: Previews,
  ctx: BrowserContext,
  inner: number,
): string[] {
  const { style } = ctx;
  if (!entry) return [style.dim("Nothing here.")];
  const known = previews.get(entryKey(entry));
  const meta = [entry.kind, entry.path, entry.priority ? `${entry.priority} priority` : null];
  const head = [style.strong(truncate(terminalSafe(entry.title), inner, style.glyph.ellipsis))];
  if (!known || known === "loading") {
    return [
      ...head,
      style.dim(meta.filter(Boolean).join(` ${style.glyph.dot} `)),
      "",
      style.dim(`reading${style.glyph.ellipsis}`),
    ];
  }
  if ("error" in known) return [...head, "", style.dim(`could not be read: ${known.error}`)];
  if (known.updatedAt) meta.push(`updated ${formatAgo(known.updatedAt, ctx.now)}`);
  return [
    ...head,
    style.dim(meta.filter(Boolean).join(` ${style.glyph.dot} `)),
    "",
    ...bodyLines(known.body, inner, style),
  ];
}

export function renderBrowser(
  entries: readonly KnowledgeEntry[],
  state: BrowserState,
  previews: Previews,
  ctx: BrowserContext,
): string[] {
  const { style } = ctx;
  const width = ctx.columns;
  const shown = filtered(entries, state.filter);
  const tree = buildTree(shown);
  const rows = visibleRows(tree, state.filter ? new Set(tree.keys()) : state.expanded);
  const items = itemsUnder(shown, state.path);
  const selected = state.focus === "items" ? items[state.item] : items[0];

  const counts = (["memory", "rule", "skill"] as const).map((kind) => {
    const n = entries.filter((e) => e.kind === kind).length;
    return `${formatCount(n)} ${kind === "memory" ? (n === 1 ? "memory" : "memories") : `${kind}${n === 1 ? "" : "s"}`}`;
  });
  const lines = [
    spread(
      `${style.accent(style.glyph.brand)} ${style.strong("pathrule")} ${style.line(style.glyph.box.v)} ${style.dim(ctx.workspace)} ${style.dim(style.glyph.arrow === "->" ? ">" : "›")} ${style.strong("Knowledge")}`,
      style.dim(counts.join(` ${style.glyph.dot} `)),
      width,
    ),
    "",
  ];

  // The filter line.
  const cursor = state.typing ? style.accent(style.glyph.bar.full) : "";
  const query =
    state.filter || state.typing
      ? `${style.accent("/")} ${state.filter}${cursor}`
      : style.dim(`/ filter by title or path`);
  lines.push(
    spread(
      ` ${query}`,
      state.filter
        ? style.dim(`${formatCount(shown.length)} match${shown.length === 1 ? "" : "es"}`)
        : "",
      width,
    ),
    "",
  );

  if (state.reading !== null && selected) {
    const known = previews.get(entryKey(selected));
    const body =
      known && known !== "loading" && !("error" in known)
        ? bodyLines(known.body, width - 6, style)
        : [style.dim(`reading${style.glyph.ellipsis}`)];
    const room = ctx.rows - lines.length - 3;
    const top = Math.max(0, Math.min(state.reading, Math.max(0, body.length - room)));
    lines.push(
      ...drawPanel(
        style,
        {
          title: truncate(terminalSafe(selected.title), width - 20, style.glyph.ellipsis),
          note: `${selected.kind} ${style.glyph.dot} ${selected.path}`,
          lines: body.slice(top, top + room),
          tone: "focus",
        },
        width,
        room + 2,
      ),
    );
    while (lines.length < ctx.rows - 1) lines.push("");
    lines.push(
      spread(
        [
          ["↑↓", "scroll"],
          ["space", "page"],
          ["esc", "back"],
        ]
          .map(([k, l]) => `${style.chip(k!)} ${style.dim(l!)}`)
          .join("  "),
        style.dim(
          body.length > room ? `${Math.min(body.length, top + room)} of ${body.length} lines` : "",
        ),
        width,
      ),
    );
    return lines.map((line) => truncate(line, width, style.glyph.ellipsis));
  }

  const area = ctx.rows - lines.length - 1;
  const treeWidth = Math.max(24, Math.min(44, Math.floor(width * 0.34)));
  const rightWidth = width - treeWidth - 1;
  const tone = (pane: BrowserState["focus"]): PanelTone =>
    state.focus === pane ? "focus" : "normal";

  // Paths.
  const treeInner = treeWidth - 4;
  const treeIndex = Math.max(
    0,
    rows.findIndex((r) => r.path === state.path),
  );
  const treeWindow = windowOf(rows, treeIndex, area - 2);
  const treeLines = treeWindow.items.map((node, i) => {
    const open = state.filter || state.expanded.has(node.path);
    const ascii = style.glyph.arrow === "->";
    const mark = node.children.length === 0 ? " " : open ? (ascii ? "v" : "▾") : ascii ? ">" : "▸";
    const label = `${"  ".repeat(Math.max(0, node.depth - 1))}${node.depth === 0 ? "" : `${mark} `}${node.depth === 0 ? ctx.workspace : node.name}`;
    const count = formatCount(node.total);
    const row = `${padEnd(truncate(label, treeInner - count.length - 1, style.glyph.ellipsis), treeInner - count.length)}${count}`;
    const isSelected = treeWindow.start + i === treeIndex;
    if (!isSelected) return row;
    return state.focus === "tree"
      ? style.highlight(style.accent(style.strong(row)))
      : style.accent(row);
  });

  // Items, then the preview under them.
  const itemsHeight = Math.max(5, Math.min(items.length + 2, Math.floor(area * 0.45)));
  const previewHeight = area - itemsHeight;
  const itemInner = rightWidth - 4;
  const itemWindow = windowOf(items, state.focus === "items" ? state.item : 0, itemsHeight - 2);
  const itemLines =
    items.length === 0
      ? [style.dim(state.filter ? "No item matches the filter." : "No items under this path.")]
      : itemWindow.items.map((entry, i) => {
          // Where below the selected path the item sits, shortened to its last folder.
          const below = entry.path === state.path ? "" : entry.path.split("/").pop()!;
          const right =
            entry.kind === "rule" && entry.priority
              ? entry.priority
              : below
                ? `${style.glyph.ellipsis}/${below}`
                : "";
          const title = terminalSafe(entry.title);
          const room = itemInner - 2 - (right ? visibleWidth(right) + 2 : 0);
          const row = spread(
            `${badge(entry.kind, style)} ${truncate(title, room, style.glyph.ellipsis)}`,
            right ? style.dim(right) : "",
            itemInner,
          );
          const isSelected = state.focus === "items" && itemWindow.start + i === state.item;
          return isSelected ? style.highlight(padEnd(row, itemInner)) : row;
        });

  const right = [
    ...drawPanel(
      style,
      {
        title: state.path === "/" ? ctx.workspace : state.path,
        note: `${formatCount(items.length)} item${items.length === 1 ? "" : "s"}`,
        lines: itemLines,
        tone: tone("items"),
      },
      rightWidth,
      itemsHeight,
    ),
    ...drawPanel(
      style,
      { title: "Preview", lines: previewLines(selected, previews, ctx, itemInner), tone: "normal" },
      rightWidth,
      previewHeight,
    ),
  ];
  lines.push(
    ...sideBySide(
      [
        drawPanel(style, { title: "Paths", lines: treeLines, tone: tone("tree") }, treeWidth, area),
        right,
      ],
      [treeWidth, rightWidth],
    ),
  );
  while (lines.length < ctx.rows - 1) lines.push("");
  const keys: Array<[string, string]> = state.typing
    ? [
        ["enter", "keep filter"],
        ["esc", "clear"],
      ]
    : state.focus === "tree"
      ? [
          ["↑↓", "move"],
          ["→", "open"],
          ["←", "close"],
          ["tab", "items"],
          ["/", "filter"],
          ["esc", "home"],
        ]
      : [
          ["↑↓", "move"],
          ["enter", "read"],
          ["tab", "paths"],
          ["/", "filter"],
          ["esc", "home"],
        ];
  const ascii = style.glyph.arrow === "->";
  lines.push(
    keys
      .map(
        ([k, l]) =>
          `${style.chip(ascii ? k.replace("↑↓", "up/down").replace("→", "right").replace("←", "left") : k)} ${style.dim(l)}`,
      )
      .join("  "),
  );
  return lines.slice(0, ctx.rows).map((line) => truncate(line, width, style.glyph.ellipsis));
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export type BrowserStep = "stay" | "leave";

/** The state after `key`, and whether the browser is left. Pure apart from `state`. */
export function browserKey(
  key: Key,
  state: BrowserState,
  entries: readonly KnowledgeEntry[],
  pageRows: number,
): BrowserStep {
  if (key.name === "interrupt" || key.name === "eof") return "leave";
  const shown = filtered(entries, state.filter);
  const tree = buildTree(shown);
  const rows = visibleRows(tree, state.filter ? new Set(tree.keys()) : state.expanded);
  const items = itemsUnder(shown, state.path);

  if (state.reading !== null) {
    if (key.name === "escape" || key.name === "left" || (key.name === "char" && key.char === "q"))
      state.reading = null;
    else if (key.name === "down" || (key.name === "char" && key.char === "j")) state.reading += 1;
    else if (key.name === "up" || (key.name === "char" && key.char === "k"))
      state.reading = Math.max(0, state.reading - 1);
    else if (key.name === "space") state.reading += Math.max(1, pageRows - 2);
    else if (key.name === "home") state.reading = 0;
    return "stay";
  }

  if (state.typing) {
    if (key.name === "enter") state.typing = false;
    else if (key.name === "escape") {
      state.typing = false;
      state.filter = "";
    } else if (key.name === "backspace") state.filter = state.filter.slice(0, -1);
    else if (key.name === "char" || key.name === "space") state.filter += key.char ?? " ";
    state.path = "/";
    state.item = 0;
    return "stay";
  }

  if (key.name === "char" && key.char === "/") {
    state.typing = true;
    return "stay";
  }
  if (key.name === "char" && key.char === "q") return "leave";
  if (key.name === "tab") {
    state.focus = state.focus === "tree" ? "items" : "tree";
    state.item = 0;
    return "stay";
  }

  if (state.focus === "tree") {
    const index = Math.max(
      0,
      rows.findIndex((r) => r.path === state.path),
    );
    const node = rows[index];
    if (key.name === "escape") {
      if (state.filter) state.filter = "";
      else return "leave";
    } else if (key.name === "up" || (key.name === "char" && key.char === "k")) {
      state.path = rows[Math.max(0, index - 1)]?.path ?? "/";
    } else if (key.name === "down" || (key.name === "char" && key.char === "j")) {
      state.path = rows[Math.min(rows.length - 1, index + 1)]?.path ?? state.path;
    } else if (key.name === "right" || key.name === "enter") {
      if (node && node.children.length > 0 && !state.expanded.has(node.path) && !state.filter)
        state.expanded.add(node.path);
      else if (items.length > 0) {
        state.focus = "items";
        state.item = 0;
      }
    } else if (key.name === "left") {
      if (node && state.expanded.has(node.path) && node.path !== "/")
        state.expanded.delete(node.path);
      else state.path = parentOf(state.path) ?? "/";
    }
    return "stay";
  }

  // Items.
  if (key.name === "escape" || key.name === "left") state.focus = "tree";
  else if (key.name === "up" || (key.name === "char" && key.char === "k"))
    state.item = Math.max(0, state.item - 1);
  else if (key.name === "down" || (key.name === "char" && key.char === "j"))
    state.item = Math.min(Math.max(0, items.length - 1), state.item + 1);
  else if (key.name === "enter" && items[state.item]) state.reading = 0;
  return "stay";
}

export interface BrowserIo {
  draw(lines: string[]): void;
  key(): Promise<Key>;
  context(): BrowserContext;
}

/**
 * Runs the browser until the person leaves it. Bodies are read on demand, one at a time, and kept
 * for the session; a body that cannot be read says why in the preview.
 */
export async function runBrowser(reader: KnowledgeReader, io: BrowserIo): Promise<void> {
  const state = initialBrowserState(reader.entries);
  const previews: Previews = new Map();
  let wanted: KnowledgeEntry | undefined;
  const draw = () => io.draw(renderBrowser(reader.entries, state, previews, io.context()));
  const load = (entry: KnowledgeEntry | undefined) => {
    wanted = entry;
    if (!entry || previews.has(entryKey(entry))) return;
    previews.set(entryKey(entry), "loading");
    void reader.read(entry).then(
      (item) => {
        previews.set(entryKey(entry), item ?? { error: "it is no longer in the store" });
        if (wanted === entry) draw();
      },
      (err: unknown) => {
        previews.set(entryKey(entry), { error: err instanceof Error ? err.message : String(err) });
        if (wanted === entry) draw();
      },
    );
  };
  for (;;) {
    const items = itemsUnder(filtered(reader.entries, state.filter), state.path);
    load(state.focus === "items" ? items[state.item] : items[0]);
    draw();
    const key = await io.key();
    if (browserKey(key, state, reader.entries, io.context().rows - 8) === "leave") return;
  }
}
