// SPDX-License-Identifier: Apache-2.0
// The Workspaces page's arithmetic, kept pure so it is tested without a browser: which workspaces a
// search keeps, their order (favorites first, then the chosen sort), the page shown, and the
// summary figures above them.
import type {
  KnowledgeKind,
  LocalWorkspaceSummary,
  WorkspaceActivitySummary,
} from "@pathrule/protocol/local-ui-api.js";

export type WorkspaceSort = "activity" | "name" | "items" | "deliveries";
export type WorkspaceView = "grid" | "table";

export const WORKSPACE_SORTS: readonly WorkspaceSort[] = [
  "activity",
  "name",
  "items",
  "deliveries",
];
/** 12 fills three or four grid columns evenly; a table row is denser. */
export const PAGE_SIZE: Record<WorkspaceView, number> = { grid: 12, table: 20 };
/** No activity for this long makes a workspace quiet. */
export const QUIET_DAYS = 30;
/** Active within this many days counts as active this week. */
export const ACTIVE_DAYS = 7;

const DAY_MS = 86_400_000;
const KINDS: readonly KnowledgeKind[] = ["memory", "rule", "skill"];

export interface DirectoryRow {
  workspace: LocalWorkspaceSummary;
  /** Null while the summary loads, or when this backend cannot give one. */
  summary: WorkspaceActivitySummary | null;
  favorite: boolean;
  items: number;
  delivered: number;
}

/** One row per listed workspace, joined with its summary and favorite mark. */
export function directoryRows(
  workspaces: readonly LocalWorkspaceSummary[],
  summaries: readonly WorkspaceActivitySummary[] | null,
  favorites: ReadonlySet<string>,
): DirectoryRow[] {
  const byId = new Map((summaries ?? []).map((entry) => [entry.id, entry]));
  return workspaces.map((workspace) => {
    const summary = byId.get(workspace.id) ?? null;
    return {
      workspace,
      summary,
      favorite: favorites.has(workspace.id),
      items: summary ? summary.items.memory + summary.items.rule + summary.items.skill : 0,
      delivered: summary ? summary.deliveries.reduce((sum, n) => sum + n, 0) : 0,
    };
  });
}

/** Whether a search keeps the row: its name or the line under it (repository or folder). */
export function matchesQuery(name: string, subtitle: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || subtitle.toLowerCase().includes(q);
}

function lastActivity(row: DirectoryRow): number {
  const at = row.summary?.lastActivityAt;
  return at ? Date.parse(at) : Number.NEGATIVE_INFINITY;
}

const byName = (a: DirectoryRow, b: DirectoryRow) =>
  a.workspace.name.localeCompare(b.workspace.name, undefined, { sensitivity: "base" }) ||
  a.workspace.id.localeCompare(b.workspace.id);

const ORDER: Record<WorkspaceSort, (a: DirectoryRow, b: DirectoryRow) => number> = {
  activity: (a, b) => lastActivity(b) - lastActivity(a) || byName(a, b),
  name: byName,
  items: (a, b) => b.items - a.items || byName(a, b),
  deliveries: (a, b) => b.delivered - a.delivered || byName(a, b),
};

export interface DirectoryPage {
  /** Rows the search kept, favorites first. */
  total: number;
  favorites: number;
  others: number;
  /** 1-based, clamped to the pages there are. */
  page: number;
  pageCount: number;
  /** This page's rows, split where favorites end. */
  groups: Array<{ favorite: boolean; rows: DirectoryRow[] }>;
}

/** Favorites first, each part in the chosen order, then the page asked for. */
export function arrange(
  rows: readonly DirectoryRow[],
  options: {
    sort: WorkspaceSort;
    page: number;
    pageSize: number;
    keep?: (row: DirectoryRow) => boolean;
  },
): DirectoryPage {
  const kept = options.keep ? rows.filter(options.keep) : [...rows];
  const order = ORDER[options.sort];
  const favorites = kept.filter((row) => row.favorite).sort(order);
  const others = kept.filter((row) => !row.favorite).sort(order);
  const ordered = [...favorites, ...others];
  const pageCount = Math.max(1, Math.ceil(ordered.length / options.pageSize));
  const page = Math.min(Math.max(1, options.page), pageCount);
  const slice = ordered.slice((page - 1) * options.pageSize, page * options.pageSize);
  const groups: DirectoryPage["groups"] = [];
  for (const row of slice) {
    const last = groups.at(-1);
    if (last && last.favorite === row.favorite) last.rows.push(row);
    else groups.push({ favorite: row.favorite, rows: [row] });
  }
  return {
    total: ordered.length,
    favorites: favorites.length,
    others: others.length,
    page,
    pageCount,
    groups,
  };
}

export type ActivityTone = "recent" | "week" | "idle" | "quiet" | "none";

/** How recent a workspace's last activity is: today, this week, this month, quiet, or never. */
export function activityTone(lastActivityAt: string | null, now: number): ActivityTone {
  if (!lastActivityAt) return "none";
  const age = now - Date.parse(lastActivityAt);
  if (age <= DAY_MS) return "recent";
  if (age <= ACTIVE_DAYS * DAY_MS) return "week";
  if (age < QUIET_DAYS * DAY_MS) return "idle";
  return "quiet";
}

/** Change against the window before, in percent; null when there is nothing to compare with. */
export function deliveryChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface DirectoryFigures {
  count: number;
  activeThisWeek: number;
  items: Record<KnowledgeKind, number>;
  itemsTotal: number;
  /** Deliveries per day across all workspaces, oldest first. */
  deliveries: number[];
  delivered: number;
  previous: number;
  change: number | null;
  quiet: number;
  /** Workspaces by last activity: today, this week, this month, 30–90 days, older. */
  ages: [number, number, number, number, number];
}

/** The figures above the list, over every workspace whatever the search or page. */
export function directoryFigures(rows: readonly DirectoryRow[], now: number): DirectoryFigures {
  const items: Record<KnowledgeKind, number> = { memory: 0, rule: 0, skill: 0 };
  let deliveries: number[] = [];
  let previous = 0;
  let activeThisWeek = 0;
  let quiet = 0;
  const ages: DirectoryFigures["ages"] = [0, 0, 0, 0, 0];
  for (const row of rows) {
    const summary = row.summary;
    if (!summary) continue;
    for (const kind of KINDS) items[kind] += summary.items[kind];
    if (deliveries.length < summary.deliveries.length) {
      deliveries = [
        ...new Array<number>(summary.deliveries.length - deliveries.length).fill(0),
        ...deliveries,
      ];
    }
    const offset = deliveries.length - summary.deliveries.length;
    summary.deliveries.forEach((n, index) => {
      deliveries[offset + index] = (deliveries[offset + index] ?? 0) + n;
    });
    previous += summary.previousDeliveries;
    if (!summary.lastActivityAt) continue;
    const age = now - Date.parse(summary.lastActivityAt);
    if (age <= ACTIVE_DAYS * DAY_MS) activeThisWeek += 1;
    if (age >= QUIET_DAYS * DAY_MS) quiet += 1;
    const bucket =
      age <= DAY_MS
        ? 0
        : age <= ACTIVE_DAYS * DAY_MS
          ? 1
          : age < QUIET_DAYS * DAY_MS
            ? 2
            : age <= 90 * DAY_MS
              ? 3
              : 4;
    ages[bucket] += 1;
  }
  const delivered = deliveries.reduce((sum, n) => sum + n, 0);
  return {
    count: rows.length,
    activeThisWeek,
    items,
    itemsTotal: items.memory + items.rule + items.skill,
    deliveries,
    delivered,
    previous,
    change: deliveryChange(delivered, previous),
    quiet,
    ages,
  };
}

/** A folder path with the home folder shortened to "~", as people write it. */
export function shortFolder(path: string, home: string | null): string {
  if (!home) return path;
  const base = home.replace(/[\\/]+$/, "");
  if (path === base) return "~";
  for (const separator of ["/", "\\"]) {
    if (path.startsWith(`${base}${separator}`))
      return `~${separator}${path.slice(base.length + 1)}`;
  }
  return path;
}
