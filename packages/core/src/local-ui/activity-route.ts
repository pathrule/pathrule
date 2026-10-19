// SPDX-License-Identifier: Apache-2.0
// `activity.recent` for both consoles: what agents logged (`pathrule_log_activity`), newest first,
// either the last few entries or every entry of a window of days, with the files each one reported
// made safe to show. Local answers from its SQLite store through the host and Pathrule Cloud from
// D1; each backend fills the fields it keeps and this module shapes them the same way.
import {
  ACTIVITY_WINDOWS,
  type ActivityRecentResponse,
  type ActivityWindow,
  type LocalActivityEntry,
} from "@pathrule/protocol/local-ui-api.js";
import type { Activity } from "../backend/inputs.js";
import type { KnowledgeBackend } from "../backend/knowledge-backend.js";

export type ActivityStore = Pick<KnowledgeBackend, "recentActivities">;

const DAY_MS = 86_400_000;
/** The last few entries (the overview's card): 30 unless asked, at most 200. */
const RECENT_DEFAULT_LIMIT = 30;
const RECENT_MAX_LIMIT = 200;
/** A window of days (the Activity page): 500 unless asked, at most 1,000. */
const WINDOW_DEFAULT_LIMIT = 500;
const WINDOW_MAX_LIMIT = 1_000;
const MAX_SUBJECTS = 5;
const MAX_FILES = 50;
const MAX_FILE_CHARS = 1_024;
/** How many path strings of one entry are looked at, whatever its files_touched holds. */
const MAX_SCANNED_PATHS = 1_000;

/**
 * Top folders of a filesystem, where homes and system files live. An absolute path that starts in
 * one is outside the workspace; a workspace-relative path written with a leading "/" does not.
 */
const SYSTEM_FOLDERS = new Set([
  "Users",
  "home",
  "root",
  "private",
  "tmp",
  "var",
  "Volumes",
  "mnt",
  "media",
  "opt",
  "usr",
  "etc",
  "Library",
  "System",
  "Applications",
  "proc",
  "sys",
  "dev",
  "nix",
  "snap",
  "run",
  "srv",
  "cygdrive",
]);

export function isActivityWindow(value: unknown): value is ActivityWindow {
  return (ACTIVITY_WINDOWS as readonly unknown[]).includes(value);
}

export interface ActivityQuery {
  limit?: number;
  days?: ActivityWindow;
}

export interface ActivityContext {
  /** The workspace's root folder when the host knows it (Local); null on Cloud. */
  root: string | null;
  /** Display names for the accounts entries were logged for (Cloud). */
  people?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

export async function recentActivity(
  store: ActivityStore,
  workspaceId: string,
  query: ActivityQuery,
  context: ActivityContext,
): Promise<ActivityRecentResponse> {
  const days = query.days;
  const requested = query.limit ?? (days ? WINDOW_DEFAULT_LIMIT : RECENT_DEFAULT_LIMIT);
  const limit = Math.min(Math.max(requested, 1), days ? WINDOW_MAX_LIMIT : RECENT_MAX_LIMIT);
  const sinceMs = days ? Date.now() - days * DAY_MS : null;
  const since = sinceMs === null ? undefined : new Date(sinceMs).toISOString();
  // One more than asked says whether there is more.
  let rows = await store.recentActivities(
    { workspaceId, relativePath: "" },
    limit + 1,
    since ? { since } : undefined,
  );
  // A store older than `since` answers the newest entries whatever their age; the window holds.
  if (sinceMs !== null) {
    rows = rows.filter((row) => {
      const at = Date.parse(row.createdAt);
      return Number.isNaN(at) || at >= sinceMs;
    });
  }
  const entries = rows.slice(0, limit).map((row) => entry(row, context.root));
  return { entries: await namedPeople(entries, context.people), truncated: rows.length > limit };
}

function entry(row: Activity, root: string | null): LocalActivityEntry {
  const actor = text(row.actorId);
  return {
    id: row.id,
    nodePath: row.nodePath,
    domain: row.domain,
    action: row.action,
    summary: row.taskSummary,
    createdAt: row.createdAt,
    scope: text(row.scope),
    subjects: activitySubjects(row.subjects),
    files: activityFiles(row.filesTouched, root),
    client: text(row.aiClient),
    // An id is its own name until `people` names it; Local keeps no account per entry.
    person: actor ? { id: actor, name: actor } : null,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Lowercase, trimmed, de-duplicated keywords, at most 5 (as writers store them). */
function activitySubjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const subjects = value
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
  return [...new Set(subjects)].slice(0, MAX_SUBJECTS);
}

async function namedPeople(
  entries: LocalActivityEntry[],
  people: ActivityContext["people"],
): Promise<LocalActivityEntry[]> {
  const ids = [...new Set(entries.flatMap((e) => (e.person ? [e.person.id] : [])))];
  if (!people || ids.length === 0) return entries;
  const names = await people(ids);
  return entries.map((e) =>
    e.person
      ? { ...e, person: { id: e.person.id, name: names.get(e.person.id) ?? e.person.id } }
      : e,
  );
}

// ── files ───────────────────────────────────────────────────────────────────

/**
 * The files an entry reports, as the console shows them: workspace-relative, de-duplicated, at
 * most 50, and never an absolute path. `files_touched` is `{ by_area: { area: paths }, total }`
 * today; a plain list, a JSON string of either, or a legacy object of lists is read the same way.
 */
export function activityFiles(raw: unknown, root: string | null): string[] {
  let value = raw;
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const found: string[] = [];
  collectPaths(value, found, 0);
  const rootSegments = root ? segmentsOf(root.replace(/\\/g, "/")) : null;
  const files = new Set<string>();
  for (const path of found) {
    const file = workspaceFile(path, rootSegments);
    if (file) files.add(file);
    if (files.size >= MAX_FILES) break;
  }
  return [...files];
}

function collectPaths(value: unknown, out: string[], depth: number): void {
  if (depth > 4 || out.length >= MAX_SCANNED_PATHS) return;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.by_area && typeof record.by_area === "object") {
      collectPaths(record.by_area, out, depth + 1);
      return;
    }
    // An object's own strings are paths only by name ({ path }); its lists and objects are walked.
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === "string" ? key === "path" || key === "file" : true) {
        collectPaths(item, out, depth + 1);
      }
    }
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

function startsWithSegments(segments: string[], prefix: string[]): boolean {
  return (
    prefix.length > 0 &&
    segments.length > prefix.length &&
    prefix.every((s, i) => s.toLowerCase() === segments[i]!.toLowerCase())
  );
}

/**
 * One reported path as a workspace-relative file, or null when it cannot be shown. The rule:
 *
 * 1. Backslashes become "/"; "." segments and repeated or trailing slashes go ("./a" is "a").
 *    A ".." segment (it climbs out of the workspace), a URL, "~" (the home folder), a UNC share
 *    ("//server") and anything with a control character are dropped.
 * 2. Under the workspace's root folder, where the host knows it (Local): made relative to it,
 *    compared case-insensitively as macOS and Windows do. A path that is the root folder's own
 *    path without its leading "/" ("Users/me/repo/a.ts", which a writer left that knew no root)
 *    counts as under it when the root starts in a system folder (see `SYSTEM_FOLDERS`), so a
 *    project's own "app/page.tsx" is never taken for a root "/app".
 * 3. A drive-letter path ("C:/…") anywhere else is dropped.
 * 4. Any other path with a leading "/" is dropped when it starts in a system folder ("/Users/…",
 *    "/home/…", "/tmp/…") or, with the root known, in the root's own first folder (a sibling of
 *    the workspace, as `normalize_workspace_path` decides at write time). The rest are agents'
 *    workspace-relative paths written with a leading "/" ("/packages/ui/x.ts") and lose the "/";
 *    that is all Cloud, which cannot know the root, can tell of them.
 * 5. A relative path that starts "Users/<name>/" is a macOS home a writer stripped of its "/" and
 *    is dropped. "home/…" stays: it is a common project folder (Linux homes are lost here only
 *    when a writer stripped them, which Cloud cannot tell apart).
 */
function workspaceFile(raw: string, rootSegments: string[] | null): string | null {
  // eslint-disable-next-line no-control-regex
  if (raw.length > MAX_FILE_CHARS || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const path = raw.trim().replace(/\\/g, "/");
  if (!path || path.startsWith("~") || path.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  const segments = segmentsOf(path);
  if (segments.length === 0 || segments.includes("..")) return null;
  const absolute = path.startsWith("/");
  const drive = /^[a-z]:$/i.test(segments[0]!);
  const root = rootSegments ?? [];
  const rootFromSystem = SYSTEM_FOLDERS.has(root[0] ?? "") || /^[a-z]:$/i.test(root[0] ?? "");
  if ((absolute || drive || rootFromSystem) && startsWithSegments(segments, root)) {
    return segments.slice(root.length).join("/");
  }
  if (drive) return null;
  if (absolute) {
    if (SYSTEM_FOLDERS.has(segments[0]!)) return null;
    if (root.length > 0 && root[0]!.toLowerCase() === segments[0]!.toLowerCase()) return null;
    return segments.join("/");
  }
  if (segments[0] === "Users" && segments.length > 2) return null;
  return segments.join("/");
}
