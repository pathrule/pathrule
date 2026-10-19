// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic work-episode clustering + search. Clusters `activity_logs`
 * on-read (so `refreshWorkEpisodes` is a no-op) via time-gap + subject/path
 * overlap session-boundary detection, and derives a deterministic title/summary
 * with no LLM curation. Emits the same WorkEpisodeBrief shape regardless of
 * how titles are produced. Shared by the SQLite-backed and in-memory backends.
 * No `better-sqlite3` import here.
 */
import type { WorkEpisodeBrief } from "@pathrule/protocol/intelligence-types.js";

/** A normalized activity row each backend feeds the clusterer (sorted any order). */
export interface EpisodeActivity {
  id: string;
  createdAt: string; // ISO
  domain: string | null;
  subjects: string[];
  /** node_path plus the parent dirs of files_touched (see co-change-rank.activityTouchedPaths). */
  touchedPaths: string[];
  taskSummary: string | null;
}

const SESSION_GAP_MS = 30 * 60 * 1000;
const MAX_SUBJECTS = 8;
const MAX_PATHS = 20;
const TITLE_MAX = 80;

function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

function meaningfulPaths(paths: string[]): string[] {
  return paths.filter((p) => p && p !== "/");
}

/** Tokenize for query matching: lowercase alphanumeric runs of length ≥ 2. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

function episodeConfidence(activityCount: number): WorkEpisodeBrief["confidence"] {
  if (activityCount >= 3) return "high";
  if (activityCount === 2) return "medium";
  return "low";
}

/**
 * Cluster activities into episodes. A new episode starts when the time gap exceeds 30 min or
 * the activity shares neither a subject nor a touched path with the running episode.
 */
export function clusterEpisodes(activities: EpisodeActivity[]): WorkEpisodeBrief[] {
  const sorted = [...activities].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const groups: EpisodeActivity[][] = [];
  let current: EpisodeActivity[] = [];
  let windowSubjects: string[] = [];
  let windowPaths: string[] = [];

  for (const act of sorted) {
    const actPaths = meaningfulPaths(act.touchedPaths);
    if (current.length === 0) {
      current = [act];
      windowSubjects = [...act.subjects];
      windowPaths = [...actPaths];
      continue;
    }
    const prev = current[current.length - 1]!;
    const gap = Date.parse(act.createdAt) - Date.parse(prev.createdAt);
    // An unparseable timestamp (NaN gap) must not force-split otherwise-related work;
    // fall back to the subject/path-overlap signal alone rather than starting a bogus
    // single-activity episode on every malformed row.
    const withinWindow = Number.isNaN(gap) ? true : gap <= SESSION_GAP_MS;
    const continues =
      withinWindow && (overlaps(act.subjects, windowSubjects) || overlaps(actPaths, windowPaths));
    if (continues) {
      current.push(act);
      windowSubjects.push(...act.subjects);
      windowPaths.push(...actPaths);
    } else {
      groups.push(current);
      current = [act];
      windowSubjects = [...act.subjects];
      windowPaths = [...actPaths];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => shapeEpisode(group));
}

function shapeEpisode(group: EpisodeActivity[]): WorkEpisodeBrief {
  const activityCount = group.length;
  const startedAt = group[0]!.createdAt;
  const endedAt = group[group.length - 1]!.createdAt;

  // Subjects ranked by frequency, top 8.
  const subjectCounts = new Map<string, number>();
  for (const a of group) {
    for (const s of a.subjects) {
      if (!s) continue;
      subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    }
  }
  const subjects = [...subjectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUBJECTS)
    .map(([s]) => s);

  // Paths: union of touched paths, sorted, capped.
  const pathSet = new Set<string>();
  for (const a of group) for (const p of meaningfulPaths(a.touchedPaths)) pathSet.add(p);
  const paths = [...pathSet].sort().slice(0, MAX_PATHS);

  const summaries = group.map((a) => a.taskSummary).filter((s): s is string => Boolean(s));
  const firstSummary = summaries[0] ?? "";
  // Deterministic title: dominant subjects, else first summary, else the lead path.
  const title =
    subjects.length > 0
      ? subjects.slice(0, 3).join(", ").slice(0, TITLE_MAX)
      : (firstSummary || paths[0] || "Recent work").slice(0, TITLE_MAX);
  const summary = (firstSummary || title).slice(0, 280);

  return {
    id: group[0]!.id, // deterministic: first activity id
    title,
    summary,
    subjects,
    paths,
    activity_count: activityCount,
    started_at: startedAt,
    ended_at: endedAt,
    confidence: episodeConfidence(activityCount),
    evidence_activity_ids: group.map((a) => a.id),
  };
}

/**
 * Cluster then return episodes relevant to `query`, newest first. Empty query → most recent.
 * `limit` caps the result (the caller passes compact=2 / deep=3 budgets).
 */
export function searchEpisodes(
  activities: EpisodeActivity[],
  query: string,
  limit: number,
): WorkEpisodeBrief[] {
  const episodes = clusterEpisodes(activities);
  const cap = limit > 0 ? limit : 2;
  const qTokens = tokens(query ?? "");

  if (qTokens.length === 0) {
    return [...episodes].sort((a, b) => b.ended_at.localeCompare(a.ended_at)).slice(0, cap);
  }

  const scored = episodes
    .map((ep) => {
      const haystack = tokens([ep.title, ep.summary, ...ep.subjects, ...ep.paths].join(" "));
      const hay = new Set(haystack);
      const score = qTokens.reduce((n, t) => n + (hay.has(t) ? 1 : 0), 0);
      return { ep, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.ep.ended_at.localeCompare(a.ep.ended_at));

  return scored.slice(0, cap).map((x) => x.ep);
}
