// SPDX-License-Identifier: Apache-2.0
// What the Signals page reads off the groups, releases and coverage a source returns: where a fix
// stands, what still needs one (by area of the code), what a newer release is proving, what each
// release brought, fixed and broke again, and how ready an application is to prove fixes. Pure:
// every function takes `now` so the page and its tests agree.
import type {
  EnvironmentCoverage,
  ReleaseCoverage,
  SignalIssue,
  VerificationPolicy,
} from "./model.js";

/**
 * Where an error group's fix stands. `open`: no fix recorded. `waiting`: a fix is recorded and no
 * newer release has run yet. `observing` / `quiet` / `verified` / `recurred` follow verification.
 * Events are outcomes, not failures: they need no fix.
 */
export type FixState =
  | "open"
  | "recurred"
  | "waiting"
  | "observing"
  | "quiet"
  | "verified"
  | "event";

export function fixState(issue: SignalIssue): FixState {
  if (issue.kind === "event") return "event";
  switch (issue.verification) {
    case "verified":
    case "recurred":
    case "observing":
    case "quiet":
      return issue.verification;
    default:
      return issue.correction ? "waiting" : "open";
  }
}

/** No fix yet, or the fix did not hold. */
export function needsFix(issue: SignalIssue): boolean {
  const state = fixState(issue);
  return issue.status === "active" && (state === "open" || state === "recurred");
}

/** A recorded fix a newer release has not proven yet. */
export function beingProven(issue: SignalIssue): boolean {
  const state = fixState(issue);
  return state === "waiting" || state === "observing" || state === "quiet";
}

/** The groups the page counts: reported (not only declared), not archived or dismissed. */
export function liveGroups(issues: readonly SignalIssue[]): SignalIssue[] {
  return issues.filter(
    (issue) =>
      issue.status !== "declared" && issue.status !== "archived" && issue.status !== "dismissed",
  );
}

/** Where in the code a group happens: the node it maps to, else the path the app declared. */
export function areaOf(issue: SignalIssue): string | null {
  return issue.resolvedPath ?? issue.declaredPath ?? null;
}

/** Events in the group's latest release, else over its life. */
export function recentCount(issue: SignalIssue): number {
  return issue.releaseOccurrences ?? issue.occurrences;
}

export interface AreaGroup {
  /** null for groups no path maps. */
  path: string | null;
  issues: SignalIssue[];
  events: number;
}

/** What needs a fix, by area: the area with most recent events first, its issues likewise. */
export function brokenByArea(issues: readonly SignalIssue[]): AreaGroup[] {
  const areas = new Map<string | null, SignalIssue[]>();
  for (const issue of issues) {
    if (!needsFix(issue)) continue;
    const path = areaOf(issue);
    areas.set(path, [...(areas.get(path) ?? []), issue]);
  }
  return [...areas.entries()]
    .map(([path, list]) => ({
      path,
      issues: [...list].sort(
        (a, b) =>
          recentCount(b) - recentCount(a) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
      ),
      events: list.reduce((sum, issue) => sum + recentCount(issue), 0),
    }))
    .sort((a, b) => {
      if ((a.path === null) !== (b.path === null)) return a.path === null ? 1 : -1;
      return b.events - a.events || (a.path ?? "").localeCompare(b.path ?? "");
    });
}

/** What a fix still needs before a newer release proves it. */
export interface ProofProgress {
  state: FixState;
  /** 0–1: the average of the conditions met so far; 1 for quiet, 0 while waiting. */
  share: number;
  /** Minutes the candidate must still run, when observing. */
  minutesLeft: number | null;
  envelopesLeft: number | null;
  successesLeft: number | null;
  /** The fix names no release, so no later release can be compared with it. */
  blocked: boolean;
  /** How long the candidate has run without a repeat, for quiet. */
  quietForMs: number | null;
}

export function proofProgress(
  issue: SignalIssue,
  policy: VerificationPolicy | undefined,
  now: number,
): ProofProgress {
  const state = fixState(issue);
  const p = issue.progress ?? null;
  const ranMs = p?.observedSince ? Math.max(0, now - Date.parse(p.observedSince)) : 0;
  const base: ProofProgress = {
    state,
    share: state === "verified" || state === "quiet" ? 1 : 0,
    minutesLeft: null,
    envelopesLeft: null,
    successesLeft: null,
    blocked: p?.blocked === "no_release",
    quietForMs: state === "quiet" && p?.observedSince ? ranMs : null,
  };
  if (state !== "observing" || !p || !policy) return base;
  const parts: number[] = [];
  const time = Math.min(1, ranMs / policy.verifiedAfterMs);
  parts.push(time);
  const envelopes = Math.min(1, p.envelopes / Math.max(1, policy.minEnvelopes));
  parts.push(envelopes);
  // A flow's successes count only when the group belongs to a flow.
  const successes = issue.flow ? Math.min(1, p.successes / Math.max(1, policy.minSuccesses)) : null;
  if (successes !== null) parts.push(successes);
  return {
    ...base,
    share: parts.reduce((sum, part) => sum + part, 0) / parts.length,
    minutesLeft: Math.max(0, Math.ceil((policy.verifiedAfterMs - ranMs) / 60_000)),
    envelopesLeft: Math.max(0, policy.minEnvelopes - p.envelopes),
    successesLeft: issue.flow ? Math.max(0, policy.minSuccesses - p.successes) : null,
  };
}

/** Fixes being proven: closest to proof first, then the ones waiting for a release. */
export function fixesBeingProven(
  issues: readonly SignalIssue[],
  policy: VerificationPolicy | undefined,
  now: number,
): Array<{ issue: SignalIssue; progress: ProofProgress }> {
  const order: Record<FixState, number> = {
    observing: 0,
    quiet: 1,
    waiting: 2,
    open: 3,
    recurred: 3,
    verified: 3,
    event: 3,
  };
  return issues
    .filter(beingProven)
    .map((issue) => ({ issue, progress: proofProgress(issue, policy, now) }))
    .sort(
      (a, b) =>
        order[a.progress.state] - order[b.progress.state] ||
        b.progress.share - a.progress.share ||
        Date.parse(b.issue.lastSeen) - Date.parse(a.issue.lastSeen),
    );
}

export interface SignalsFigures {
  needFix: number;
  waitForProof: number;
  /** Areas of the code with an open issue. */
  areas: number;
  cameBack: number;
  /** Groups with a recorded fix (any outcome). */
  recordedFixes: number;
  /** The release the latest recurrence happened in. */
  cameBackIn: string | null;
  observing: number;
  quiet: number;
  waiting: number;
  proven: number;
  /** The median time from a fix record to its proof, among proven groups; null without one. */
  medianProofMs: number | null;
  /** The observing fix nearest to proof. */
  next: { release: string | null; minutesLeft: number | null } | null;
}

export function signalsFigures(
  issues: readonly SignalIssue[],
  policy: VerificationPolicy | undefined,
  now: number,
): SignalsFigures {
  const errors = issues.filter((issue) => issue.kind === "error");
  const count = (state: FixState) => errors.filter((issue) => fixState(issue) === state).length;
  const open = errors.filter(
    (issue) =>
      issue.status === "active" &&
      ["open", "recurred", "observing", "waiting"].includes(fixState(issue)),
  );
  const areas = new Set(open.map(areaOf));
  const recurred = errors
    .filter((issue) => fixState(issue) === "recurred")
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  const proofTimes = errors
    .filter(
      (issue) => fixState(issue) === "verified" && issue.correction && issue.progress?.updatedAt,
    )
    .map(
      (issue) => Date.parse(issue.progress!.updatedAt!) - Date.parse(issue.correction!.recordedAt),
    )
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const median =
    proofTimes.length === 0
      ? null
      : proofTimes.length % 2
        ? proofTimes[(proofTimes.length - 1) / 2]!
        : (proofTimes[proofTimes.length / 2 - 1]! + proofTimes[proofTimes.length / 2]!) / 2;
  const observing = fixesBeingProven(errors, policy, now).find(
    (entry) => entry.progress.state === "observing",
  );
  return {
    needFix: open.filter(needsFix).length,
    waitForProof: open.length - open.filter(needsFix).length,
    areas: areas.size,
    cameBack: recurred.length,
    recordedFixes: errors.filter((issue) => issue.correction).length,
    cameBackIn: recurred[0]?.progress?.recurredRelease ?? recurred[0]?.release ?? null,
    observing: count("observing"),
    quiet: count("quiet"),
    waiting: count("waiting"),
    proven: count("verified"),
    medianProofMs: median,
    next: observing
      ? {
          release: observing.issue.progress?.candidateRelease ?? null,
          minutesLeft: observing.progress.minutesLeft,
        }
      : null,
  };
}

export interface ReleaseRow {
  release: string | null;
  envelopes: number;
  firstSeen: string;
  lastSeen: string;
  latest: boolean;
  /** Error groups first seen while this release was the newest. */
  newIssues: number;
  /** Fixes this release proved. */
  proven: number;
  /** Fixes that did not hold in this release. */
  cameBack: number;
}

/** One environment's releases, newest first, with what each brought, fixed and broke again. */
export function releaseRows(
  releases: readonly ReleaseCoverage[],
  issues: readonly SignalIssue[],
  environment: string,
): ReleaseRow[] {
  const mine = releases
    .filter((release) => release.environment === environment)
    .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
  const errors = issues.filter(
    (issue) => issue.kind === "error" && issue.environment === environment,
  );
  return mine.map((release, index) => {
    const from = Date.parse(release.firstSeen);
    const until = index === 0 ? Number.POSITIVE_INFINITY : Date.parse(mine[index - 1]!.firstSeen);
    return {
      release: release.release,
      envelopes: release.envelopes,
      firstSeen: release.firstSeen,
      lastSeen: release.lastSeen,
      latest: index === 0,
      newIssues: errors.filter((issue) => {
        const first = Date.parse(issue.firstSeen);
        return first >= from && first < until;
      }).length,
      proven: errors.filter(
        (issue) =>
          fixState(issue) === "verified" &&
          release.release !== null &&
          issue.progress?.candidateRelease === release.release,
      ).length,
      cameBack: errors.filter(
        (issue) =>
          fixState(issue) === "recurred" &&
          release.release !== null &&
          (issue.progress?.recurredRelease ?? issue.release) === release.release,
      ).length,
    };
  });
}

/** How an environment's connection reads now. */
export type ConnectionState = "receiving" | "quiet" | "silent";

export interface Connection {
  environment: string;
  release: string | null;
  state: ConnectionState;
  lastSeen: string | null;
  /** 72 hourly buckets, oldest first: whether the app was heard in that hour; null where the runtime keeps no hours. */
  hours: boolean[] | null;
  /** Share of the 72 hours heard; null where the runtime keeps no hours. */
  coverage: number | null;
}

const HOUR_MS = 3_600_000;

export function connections(coverage: readonly EnvironmentCoverage[], now: number): Connection[] {
  const current = Math.floor(now / HOUR_MS);
  const order = environmentsOf([], coverage);
  const sorted = [...coverage].sort(
    (a, b) => order.indexOf(a.environment) - order.indexOf(b.environment),
  );
  return sorted.map((env) => {
    const heard = env.coverageHours
      ? new Set(env.coverageHours.map((hour) => Math.floor(Date.parse(hour) / HOUR_MS)))
      : null;
    const hours = heard
      ? Array.from({ length: 72 }, (_, i) => heard.has(current - (71 - i)))
      : null;
    const age = env.lastSeen ? now - Date.parse(env.lastSeen) : Number.POSITIVE_INFINITY;
    return {
      environment: env.environment,
      release: env.release,
      state: age <= HOUR_MS ? "receiving" : age <= 24 * HOUR_MS ? "quiet" : "silent",
      lastSeen: env.lastSeen,
      hours,
      coverage: hours ? hours.filter(Boolean).length / 72 : null,
    };
  });
}

/** One line of "Ready to prove fixes". */
export type ReadinessCheck =
  | { key: "production"; ok: boolean; release: string | null; lastSeen: string | null }
  | { key: "releases"; ok: boolean; missing: string[] }
  | { key: "successes"; ok: boolean; flows: number; withSuccesses: number; missing: string[] }
  | { key: "points"; ok: boolean; declared: number; waiting: string[] };

/**
 * What a fix needs before a release can prove it: an app that reports from production, releases
 * that name themselves, flows that report successes, and instrumented points that have fired.
 */
export function readiness(
  issues: readonly SignalIssue[],
  coverage: readonly EnvironmentCoverage[],
  now: number,
): ReadinessCheck[] {
  const production = coverage.find((env) => env.environment === "production") ?? null;
  const heardRecently = production?.lastSeen
    ? now - Date.parse(production.lastSeen) <= 24 * HOUR_MS
    : false;
  const unnamed = coverage
    .filter((env) => env.lastSeen && !env.release)
    .map((env) => env.environment);
  const blocked = issues.some((issue) => issue.progress?.blocked === "no_release");
  const live = liveGroups(issues);
  const flows = new Set(
    live.filter((issue) => issue.kind === "error" && issue.flow).map((issue) => issue.flow!),
  );
  const succeeding = new Set([
    ...live.filter((issue) => issue.kind === "event" && issue.flow).map((issue) => issue.flow!),
    ...live
      .filter((issue) => issue.flow && (issue.progress?.successes ?? 0) > 0)
      .map((issue) => issue.flow!),
  ]);
  const missing = [...flows].filter((flow) => !succeeding.has(flow)).sort();
  const declared = issues.filter((issue) => issue.status === "declared");
  return [
    {
      key: "production",
      ok: heardRecently,
      release: production?.release ?? null,
      lastSeen: production?.lastSeen ?? null,
    },
    { key: "releases", ok: unnamed.length === 0 && !blocked, missing: unnamed },
    {
      key: "successes",
      ok: missing.length === 0,
      flows: flows.size,
      withSuccesses: flows.size - missing.length,
      missing,
    },
    {
      key: "points",
      ok: declared.length === 0,
      declared: declared.length,
      waiting: declared
        .map((issue) => issue.label ?? issue.declaredPath ?? issue.fingerprint)
        .slice(0, 6),
    },
  ];
}

/** The environments to choose from: production first, then the rest by name. */
export function environmentsOf(
  issues: readonly SignalIssue[],
  coverage: readonly EnvironmentCoverage[],
): string[] {
  const all = new Set([
    ...coverage.map((env) => env.environment),
    ...issues.map((i) => i.environment),
  ]);
  return [...all].sort((a, b) =>
    a === "production" ? -1 : b === "production" ? 1 : a.localeCompare(b),
  );
}
