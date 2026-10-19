// SPDX-License-Identifier: Apache-2.0
// What the Activity page reads off the entries agents logged: work sessions (one person and one
// agent, no gap over 30 minutes), the folder each entry landed in, what agents knew there, the
// kind of work and how well each agent logs. Entries are the agents' own words: nothing here is
// checked against the code. Pure: every function takes `now` where time matters.
import type { KnowledgeListItem, LocalActivityEntry } from "@pathrule/protocol/local-ui-api.js";

/** A gap longer than this between two entries of one person and agent starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;

/** Knowledge not edited for this long reads as older than the work around it. */
export const STALE_MS = 90 * 86_400_000;

const DAY_MS = 86_400_000;

function normalize(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * The folder an entry landed in: the node the agent named, else the deepest folder its files
 * share (at most three levels), else the workspace root.
 */
export function entryFolder(entry: LocalActivityEntry): string {
  if (entry.nodePath && normalize(entry.nodePath) !== "/") return normalize(entry.nodePath);
  const dirs = (entry.files ?? [])
    .map((file) =>
      file
        .replace(/^\.?\//, "")
        .split("/")
        .slice(0, -1),
    )
    .filter((parts) => parts.length > 0);
  if (dirs.length === 0) return "/";
  const shared: string[] = [];
  for (let i = 0; i < Math.min(3, ...dirs.map((d) => d.length)); i += 1) {
    const part = dirs[0]![i]!;
    if (dirs.every((d) => d[i] === part)) shared.push(part);
    else break;
  }
  return shared.length ? `/${shared.join("/")}` : "/";
}

/** Who an entry was logged for: the Cloud account, else the one user of Local. */
export function personKey(entry: LocalActivityEntry): string {
  return entry.person?.id ?? "local";
}

export interface WorkSession {
  id: string;
  personId: string;
  personName: string | null;
  client: string | null;
  start: string;
  end: string;
  /** Newest first. */
  entries: LocalActivityEntry[];
  /** The entry that says most about the session: the one with the most files, the latest on a tie. */
  title: string | null;
  subjects: string[];
  files: string[];
  folders: string[];
  /** Entries per domain, most first. */
  domains: Array<{ domain: string; count: number }>;
}

/** Sessions, newest first. */
export function workSessions(entries: readonly LocalActivityEntry[]): WorkSession[] {
  const ordered = [...entries].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const open = new Map<string, LocalActivityEntry[]>();
  const done: LocalActivityEntry[][] = [];
  for (const entry of ordered) {
    const key = `${personKey(entry)}\u0000${entry.client ?? ""}`;
    const current = open.get(key);
    const last = current?.[current.length - 1];
    if (
      current &&
      last &&
      Date.parse(entry.createdAt) - Date.parse(last.createdAt) <= SESSION_GAP_MS
    ) {
      current.push(entry);
    } else {
      if (current) done.push(current);
      open.set(key, [entry]);
    }
  }
  done.push(...open.values());
  return done
    .map((list): WorkSession => {
      const newest = [...list].reverse();
      const counts = (values: string[]) => {
        const map = new Map<string, number>();
        for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
        return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      };
      const lead = [...list].sort(
        (a, b) =>
          (b.files?.length ?? 0) - (a.files?.length ?? 0) ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt),
      )[0]!;
      return {
        id: `${personKey(list[0]!)}:${list[0]!.client ?? ""}:${list[0]!.createdAt}`,
        personId: personKey(list[0]!),
        personName: list.find((entry) => entry.person)?.person?.name ?? null,
        client: list[0]!.client ?? null,
        start: list[0]!.createdAt,
        end: list[list.length - 1]!.createdAt,
        entries: newest,
        title: lead.summary ?? newest.find((entry) => entry.summary)?.summary ?? null,
        subjects: counts(list.flatMap((entry) => entry.subjects ?? []))
          .slice(0, 4)
          .map(([subject]) => subject),
        files: [...new Set(list.flatMap((entry) => entry.files ?? []))],
        folders: [...new Set(list.map(entryFolder))],
        domains: counts(list.map((entry) => entry.domain ?? "other")).map(([domain, count]) => ({
          domain,
          count,
        })),
      };
    })
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
}

/** Sessions by the UTC day they ended in, newest first. */
export function sessionsByDay(
  sessions: readonly WorkSession[],
): Array<{ day: string; sessions: WorkSession[] }> {
  const days = new Map<string, WorkSession[]>();
  for (const session of sessions) {
    const day = session.end.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), session]);
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({ day, sessions: list }));
}

/** What agents knew in a folder: knowledge there or in a folder above it (the root aside). */
export type FolderKnowledge =
  | { state: "none"; items: 0; older: 0 }
  | { state: "older" | "current"; items: number; older: number };

export function knowledgeIn(
  folder: string,
  knowledge: readonly KnowledgeListItem[],
  now: number,
): FolderKnowledge {
  const at = normalize(folder);
  const covering = knowledge.filter((item) =>
    (item.paths?.length ? item.paths : item.path ? [item.path] : [])
      .map(normalize)
      .some((path) => path !== "/" && (at === path || at.startsWith(`${path}/`))),
  );
  if (covering.length === 0) return { state: "none", items: 0, older: 0 };
  const older = covering.filter((item) => now - Date.parse(item.updatedAt) > STALE_MS).length;
  return { state: older > 0 ? "older" : "current", items: covering.length, older };
}

export interface FolderRow {
  folder: string;
  sessions: number;
  knowledge: FolderKnowledge;
}

/** Where work landed: folders by sessions, most first, with what agents knew there. */
export function foldersTouched(
  sessions: readonly WorkSession[],
  knowledge: readonly KnowledgeListItem[] | null,
  now: number,
): FolderRow[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const folder of session.folders) counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([folder, count]) => ({
      folder,
      sessions: count,
      knowledge: knowledge
        ? knowledgeIn(folder, knowledge, now)
        : ({ state: "current", items: 0, older: 0 } as FolderKnowledge),
    }));
}

export interface AgentRow {
  client: string;
  entries: number;
  /** Share of its entries that name the files they touched. */
  withFiles: number;
}

export function agentsOf(entries: readonly LocalActivityEntry[]): AgentRow[] {
  const map = new Map<string, { entries: number; withFiles: number }>();
  for (const entry of entries) {
    const client = entry.client ?? "unknown";
    const row = map.get(client) ?? { entries: 0, withFiles: 0 };
    row.entries += 1;
    if ((entry.files?.length ?? 0) > 0) row.withFiles += 1;
    map.set(client, row);
  }
  return [...map.entries()]
    .map(([client, row]) => ({
      client,
      entries: row.entries,
      withFiles: row.withFiles / row.entries,
    }))
    .sort((a, b) => b.entries - a.entries || a.client.localeCompare(b.client));
}

/** Entries per domain, most first. */
export function domainMix(
  entries: readonly LocalActivityEntry[],
): Array<{ domain: string; count: number }> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const domain = entry.domain ?? "other";
    map.set(domain, (map.get(domain) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([domain, count]) => ({ domain, count }));
}

/** Per UTC day over the window, oldest first: `value(day)` for each of the last `days` days. */
export function perDay<T>(
  days: number,
  now: number,
  value: (day: string) => T,
): Array<{ day: string; value: T }> {
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return { day, value: value(day) };
  });
}

export interface ActivityFilter {
  query: string;
  domain: string | null;
  person: string | null;
  client: string | null;
}

export function matchesEntry(entry: LocalActivityEntry, filter: ActivityFilter): boolean {
  if (filter.domain && (entry.domain ?? "other") !== filter.domain) return false;
  if (filter.person && personKey(entry) !== filter.person) return false;
  if (filter.client && (entry.client ?? "unknown") !== filter.client) return false;
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    entry.summary,
    entry.nodePath,
    entry.domain,
    entry.action,
    ...(entry.subjects ?? []),
    ...(entry.files ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => hay.includes(word));
}
