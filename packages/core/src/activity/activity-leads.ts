// SPDX-License-Identifier: Apache-2.0
//
// Activity is a navigation lead, never proof that a change worked or a team rule.
// Pure and model-free: usable by the desktop, local backend and hosted backend.
export interface ActivityProvenance {
  version: 1;
  summarySource: "agent_authored" | "user_intent" | "derived" | "unknown";
  filesSource: "observed_tools" | "agent_reported" | "unknown";
  threadId?: string;
  turnId?: string;
  observedFileCount: number;
  storedFileCount: number;
  filesTruncated: boolean;
  outcome: "unknown";
}

export interface ActivityLeadSource {
  id: string;
  createdAt: string;
  filesTouched: { total?: number; by_area?: Record<string, string[]>; normalized_v1?: boolean };
  provenance?: ActivityProvenance;
}

const summarySources = new Set(["agent_authored", "user_intent", "derived", "unknown"]);
const fileSources = new Set(["observed_tools", "agent_reported", "unknown"]);
const count = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
const identity = (s: unknown): string | undefined =>
  typeof s === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(s) ? s : undefined;

/** Tolerant boundary. Extra fields (including model-authored success claims) are discarded. */
export function normalizeActivityProvenance(value: unknown): ActivityProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (p.version !== 1) return undefined;
  const stored = count(p.storedFileCount);
  const observed = Math.max(stored, count(p.observedFileCount));
  return {
    version: 1,
    summarySource: summarySources.has(String(p.summarySource))
      ? (p.summarySource as ActivityProvenance["summarySource"])
      : "unknown",
    filesSource: fileSources.has(String(p.filesSource))
      ? (p.filesSource as ActivityProvenance["filesSource"])
      : "unknown",
    threadId: identity(p.threadId),
    turnId: identity(p.turnId),
    observedFileCount: observed,
    storedFileCount: stored,
    filesTruncated: p.filesTruncated === true || observed > stored,
    outcome: "unknown",
  };
}

/** Only already-normalized, non-sensitive source paths enter learning context. No file I/O. */
export function isSafeSourcePath(path: string): boolean {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1f:]/.test(path)
  )
    return false;
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return false;
  if (
    parts.some((p) =>
      /^(?:\.env(?:\..*)?|\.secrets?|secrets?|credentials?(?:\..*)?|\.git|node_modules|vendor|dist|build|coverage)$/i.test(
        p,
      ),
    )
  )
    return false;
  return !/(?:\.(?:pem|key|p12|pfx|keystore)|(?:^|\/)id_(?:rsa|ed25519))$/i.test(path);
}

export interface ActivityLeads {
  phase: "cold_start" | "incremental" | "unknown";
  historyStatus: "available" | "unavailable";
  evidenceStatus: "activity_only";
  sampledActivities: number;
  unlocatedActivities: number;
  truncatedActivities: number;
  targets: Array<{
    path: string;
    activityCount: number;
    lastObservedAt: string;
    activityRefs: string[];
    summarySources: ActivityProvenance["summarySource"][];
    needs: "source_verification";
  }>;
  instruction: string;
}

/** Bounded review priorities. Repeated delivery of one turn cannot inflate its weight. */
export function buildActivityLeads(
  activities: readonly ActivityLeadSource[],
  scope = "/",
  limit = 8,
  historyAvailable = true,
): ActivityLeads {
  const scoped = scope.replace(/^\/+|\/+$/g, "");
  const groups = new Map<
    string,
    { ids: Set<string>; last: string; sources: Set<ActivityProvenance["summarySource"]> }
  >();
  const seen = new Set<string>();
  let sampled = 0,
    unlocated = 0,
    truncated = 0;
  for (const a of activities.slice(0, 200)) {
    if (!a.id || !Number.isFinite(Date.parse(a.createdAt))) continue;
    const p = normalizeActivityProvenance(a.provenance);
    const key = p?.threadId && p.turnId ? JSON.stringify([p.threadId, p.turnId]) : a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    sampled++;
    if (p?.filesTruncated) truncated++;
    const paths = new Set<string>();
    if (a.filesTouched?.normalized_v1 === true && a.filesTouched.by_area) {
      for (const list of Object.values(a.filesTouched.by_area)) {
        if (!Array.isArray(list)) continue;
        for (const path of list.slice(0, 60)) {
          if (typeof path === "string" && isSafeSourcePath(path)) paths.add(path);
          if (paths.size >= 60) break;
        }
        if (paths.size >= 60) break;
      }
    }
    if (!paths.size) unlocated++;
    for (const path of paths) {
      if (scoped && path !== scoped && !path.startsWith(scoped + "/")) continue;
      const g = groups.get(path) ?? {
        ids: new Set<string>(),
        last: a.createdAt,
        sources: new Set<ActivityProvenance["summarySource"]>(),
      };
      g.ids.add(a.id);
      if (Date.parse(a.createdAt) > Date.parse(g.last)) g.last = a.createdAt;
      g.sources.add(p?.summarySource ?? "unknown");
      groups.set(path, g);
    }
  }
  const targets = [...groups.entries()]
    .sort(
      ([pa, a], [pb, b]) =>
        b.ids.size - a.ids.size || Date.parse(b.last) - Date.parse(a.last) || pa.localeCompare(pb),
    )
    .slice(0, Math.max(0, Math.min(12, Math.floor(limit) || 0)))
    .map(([path, g]) => ({
      path,
      activityCount: g.ids.size,
      lastObservedAt: g.last,
      activityRefs: [...g.ids].slice(0, 3),
      summarySources: [...g.sources].sort(),
      needs: "source_verification" as const,
    }));
  return {
    phase: !historyAvailable ? "unknown" : sampled ? "incremental" : "cold_start",
    historyStatus: historyAvailable ? "available" : "unavailable",
    evidenceStatus: "activity_only",
    sampledActivities: sampled,
    unlocatedActivities: unlocated,
    truncatedActivities: truncated,
    targets,
    instruction:
      "These are historical activity leads, not verified architecture, successful fixes or team rules. Inspect current source and Git revision before using them. Missing activity is not evidence of an untouched or understood area.",
  };
}
