// SPDX-License-Identifier: Apache-2.0
// The knowledge page's arithmetic, kept pure so it is tested without a browser: the path tree and
// the topics an item belongs to, what a scope, a search and a health filter keep, the order, the
// groups (one per path or per topic) and the page of groups shown.
import type {
  KnowledgeKind,
  KnowledgeListItem,
  KnowledgeTopicsResponse,
} from "@pathrule/protocol/local-ui-api.js";
import { healthOf, type HealthState } from "../overview/model.js";

export type BrowseMode = "paths" | "topics";
export type KindFilter = KnowledgeKind | "all";
export type KnowledgeSort = "delivered" | "edited" | "title";
export type HealthFilter = HealthState | "all";

export const KNOWLEDGE_SORTS: readonly KnowledgeSort[] = ["delivered", "edited", "title"];
/** Rows a group shows before "Show more", and how many each press adds. */
export const ROWS_PER_GROUP = 5;
export const ROWS_STEP = 20;
export const GROUPS_PER_PAGE = 8;
/** The topics list's entry for items with no topical edge. */
export const CONVENTIONS = "conventions";

export const itemKey = (item: { kind: KnowledgeKind; id: string }) => `${item.kind}:${item.id}`;

// ── topics ───────────────────────────────────────────────────────────────

export interface TopicEntry {
  id: string;
  /** The model's name, or the topic's words when none named it. */
  label: string;
  named: boolean;
  terms: string[];
  homePath: string;
}

export interface TopicIndex {
  topics: TopicEntry[];
  byItem: ReadonlyMap<string, TopicEntry>;
  conventions: ReadonlySet<string>;
}

export const NO_TOPICS: TopicIndex = { topics: [], byItem: new Map(), conventions: new Set() };

// Words that say nothing about a topic, in the languages people write knowledge in. An unnamed topic
// (no model named it) is labelled by its other words.
const FILLER = new Set(
  (
    "a an and are as at be been but by can do does for from has have how if in into is it its no not of on " +
    "or our so such than that the their them then there these they this those to too was we were what when " +
    "which who will with you your all any also each more most some very just only about over under via use " +
    "ve ile bir bu şu için da de ki çok gibi olan olarak daha her ama veya ya " +
    "der die das und ist mit für von zu den dem ein eine le la les et des du un une est pour dans el los las y " +
    "en por para con del"
  ).split(" "),
);

/** An unnamed topic's label: up to three of its words that carry meaning, else its home folder's name. */
export function topicLabel(terms: readonly string[], homePath: string): string {
  const words = terms
    .filter((term) => term.length > 1 && !FILLER.has(term.toLowerCase()))
    .slice(0, 3);
  if (words.length) return words.join(" · ");
  const folder = homePath.split("/").filter(Boolean).pop();
  return folder ?? terms.slice(0, 3).join(" · ");
}

export function topicIndex(response: KnowledgeTopicsResponse | null): TopicIndex {
  if (!response) return NO_TOPICS;
  const byItem = new Map<string, TopicEntry>();
  const topics = response.topics.map((topic) => {
    const entry: TopicEntry = {
      id: topic.id,
      label: topic.name ?? topicLabel(topic.terms, topic.homePath),
      named: topic.name !== null,
      terms: topic.terms,
      homePath: topic.homePath,
    };
    for (const ref of topic.items) byItem.set(itemKey(ref), entry);
    return entry;
  });
  return { topics, byItem, conventions: new Set(response.conventions.map(itemKey)) };
}

// ── the path tree ─────────────────────────────────────────────────────────

export interface PathNode {
  path: string;
  /** The last segment; "/" for the root. */
  label: string;
  depth: number;
  /** Items at this path or under it. */
  count: number;
  hasChildren: boolean;
  parent: string | null;
}

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/** Every folder that holds items, with its ancestors, depth first and by name. */
export function pathTree(items: readonly KnowledgeListItem[]): PathNode[] {
  const counts = new Map<string, number>([["/", 0]]);
  for (const item of items) {
    if (!item.path) continue;
    for (let path: string | null = item.path; path !== null; path = parentOf(path)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const children = new Map<string, string[]>();
  for (const path of counts.keys()) {
    const parent = parentOf(path);
    if (parent === null) continue;
    children.set(parent, [...(children.get(parent) ?? []), path]);
  }
  const nodes: PathNode[] = [];
  const walk = (path: string, depth: number) => {
    const kids = (children.get(path) ?? []).sort((a, b) => a.localeCompare(b));
    nodes.push({
      path,
      label: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1),
      depth,
      count: counts.get(path) ?? 0,
      hasChildren: kids.length > 0,
      parent: parentOf(path),
    });
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk("/", 0);
  return nodes;
}

/** The nodes to show: the root's children always, any other node's when it is expanded. */
export function visibleNodes(
  nodes: readonly PathNode[],
  expanded: ReadonlySet<string>,
): PathNode[] {
  const shown = new Set<string>(["/"]);
  return nodes.filter((node) => {
    if (node.parent === null) return true;
    const visible = shown.has(node.parent) && (node.parent === "/" || expanded.has(node.parent));
    if (visible) shown.add(node.path);
    return visible;
  });
}

/** How many of a folder's children the rail lists before "N more folders". */
export const CHILDREN_SHOWN = 8;

export type TreeRow =
  | { kind: "node"; node: PathNode }
  | { kind: "more"; parent: string; depth: number; hidden: number };

/**
 * The rail's rows. Without a filter: the visible nodes, with at most `CHILDREN_SHOWN` children of a
 * folder until its "more" row is opened. With one: every folder whose path holds it, with its ancestors.
 */
export function treeRows(
  nodes: readonly PathNode[],
  expanded: ReadonlySet<string>,
  opened: ReadonlySet<string>,
  filter = "",
): TreeRow[] {
  const needle = filter.trim().toLowerCase();
  if (needle) {
    const byPath = new Map(nodes.map((node) => [node.path, node]));
    const keep = new Set<string>(["/"]);
    for (const node of nodes) {
      if (node.path === "/" || !node.path.toLowerCase().includes(needle)) continue;
      for (let path: string | null = node.path; path && !keep.has(path); ) {
        keep.add(path);
        path = byPath.get(path)?.parent ?? null;
      }
    }
    return nodes.filter((node) => keep.has(node.path)).map((node) => ({ kind: "node", node }));
  }
  const children = new Map<string, number>();
  for (const node of nodes)
    if (node.parent) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
  const rows: TreeRow[] = [];
  const seen = new Map<string, number>();
  const hidden = new Set<string>();
  for (const node of visibleNodes(nodes, expanded)) {
    if (node.parent && hidden.has(node.parent)) {
      hidden.add(node.path);
      continue;
    }
    if (node.parent) {
      const index = seen.get(node.parent) ?? 0;
      seen.set(node.parent, index + 1);
      if (index >= CHILDREN_SHOWN && !opened.has(node.parent)) {
        hidden.add(node.path);
        if (index === CHILDREN_SHOWN)
          rows.push({
            kind: "more",
            parent: node.parent,
            depth: node.depth,
            hidden: (children.get(node.parent) ?? 0) - CHILDREN_SHOWN,
          });
        continue;
      }
    }
    rows.push({ kind: "node", node });
  }
  return rows;
}

// ── what a view keeps ─────────────────────────────────────────────────────

export interface ViewFilter {
  browse: BrowseMode;
  /** A path, a topic id, CONVENTIONS, or null for everything. */
  scope: string | null;
  query: string;
  health: HealthFilter;
}

export function inScope(
  item: KnowledgeListItem,
  browse: BrowseMode,
  scope: string | null,
  topics: TopicIndex,
): boolean {
  if (scope === null) return true;
  if (browse === "paths") {
    if (scope === "/") return true;
    return item.path === scope || (item.path?.startsWith(`${scope}/`) ?? false);
  }
  if (scope === CONVENTIONS) return topics.conventions.has(itemKey(item));
  return topics.byItem.get(itemKey(item))?.id === scope;
}

/** Whether a search keeps an item: its title, text, paths, tags or topic. */
export function matchesQuery(item: KnowledgeListItem, query: string, topics: TopicIndex): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const topic = topics.byItem.get(itemKey(item));
  const haystack = [
    item.title,
    item.preview,
    ...(item.paths ?? (item.path ? [item.path] : [])),
    ...(item.tags ?? []),
    topic?.label ?? "",
    ...(topic?.terms ?? []),
  ]
    .join("\n")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** The items a view keeps before its health filter: the health chips count these. */
export function scopedItems(
  items: readonly KnowledgeListItem[],
  filter: ViewFilter,
  topics: TopicIndex,
): KnowledgeListItem[] {
  return items.filter(
    (item) =>
      inScope(item, filter.browse, filter.scope, topics) &&
      matchesQuery(item, filter.query, topics),
  );
}

export function keepHealth(
  items: readonly KnowledgeListItem[],
  health: HealthFilter,
  delivered: ReadonlyMap<string, number> | null,
  now: number,
): KnowledgeListItem[] {
  if (health === "all") return [...items];
  return items.filter((item) => healthOf(item, delivered, now) === health);
}

export function sortItems(
  items: readonly KnowledgeListItem[],
  sort: KnowledgeSort,
  delivered: ReadonlyMap<string, number> | null,
): KnowledgeListItem[] {
  const count = (item: KnowledgeListItem) => delivered?.get(itemKey(item)) ?? 0;
  const byTitle = (a: KnowledgeListItem, b: KnowledgeListItem) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const order = {
    delivered: (a: KnowledgeListItem, b: KnowledgeListItem) =>
      count(b) - count(a) || b.updatedAt.localeCompare(a.updatedAt),
    edited: (a: KnowledgeListItem, b: KnowledgeListItem) =>
      b.updatedAt.localeCompare(a.updatedAt) || byTitle(a, b),
    title: byTitle,
  }[sort];
  return [...items].sort(order);
}

// ── groups ───────────────────────────────────────────────────────────────

export interface KnowledgeGroup {
  key: string;
  kind: "path" | "topic" | "conventions" | "none";
  /** A path, a topic's label; "" for items with no path or topic. */
  label: string;
  topic: TopicEntry | null;
  items: KnowledgeListItem[];
  delivered: number;
}

/** One group per path or per topic, the largest first; items keep their order inside. */
export function groupItems(
  items: readonly KnowledgeListItem[],
  browse: BrowseMode,
  topics: TopicIndex,
  delivered: ReadonlyMap<string, number> | null,
): KnowledgeGroup[] {
  const groups = new Map<string, KnowledgeGroup>();
  for (const item of items) {
    let key: string;
    let base: Omit<KnowledgeGroup, "items" | "delivered">;
    if (browse === "paths") {
      key = item.path ?? "";
      base = { key, kind: item.path ? "path" : "none", label: item.path ?? "", topic: null };
    } else {
      const topic = topics.byItem.get(itemKey(item)) ?? null;
      if (topic) {
        key = topic.id;
        base = { key, kind: "topic", label: topic.label, topic };
      } else if (topics.conventions.has(itemKey(item))) {
        key = CONVENTIONS;
        base = { key, kind: "conventions", label: "", topic: null };
      } else {
        key = "";
        base = { key, kind: "none", label: "", topic: null };
      }
    }
    const group = groups.get(key) ?? { ...base, items: [], delivered: 0 };
    group.items.push(item);
    group.delivered += delivered?.get(itemKey(item)) ?? 0;
    groups.set(key, group);
  }
  const last = (group: KnowledgeGroup) => (group.kind === "none" ? 1 : 0);
  return [...groups.values()].sort(
    (a, b) =>
      last(a) - last(b) ||
      b.items.length - a.items.length ||
      b.delivered - a.delivered ||
      a.label.localeCompare(b.label),
  );
}

export function pageOf<T>(
  list: readonly T[],
  page: number,
  size: number,
): { slice: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  return { slice: list.slice((current - 1) * size, current * size), page: current, pageCount };
}

/** Items related to one: same topic first, then same path; never itself. */
export function relatedItems(
  item: KnowledgeListItem,
  items: readonly KnowledgeListItem[],
  topics: TopicIndex,
  limit = 3,
): Array<{ item: KnowledgeListItem; why: "topic" | "path" }> {
  const topic = topics.byItem.get(itemKey(item))?.id;
  const others = items.filter((other) => itemKey(other) !== itemKey(item));
  const sameTopic = topic
    ? others.filter((other) => topics.byItem.get(itemKey(other))?.id === topic)
    : [];
  const samePath = item.path
    ? others.filter((other) => other.path === item.path && !sameTopic.includes(other))
    : [];
  return [
    ...sameTopic.map((other) => ({ item: other, why: "topic" as const })),
    ...samePath.map((other) => ({ item: other, why: "path" as const })),
  ].slice(0, limit);
}
