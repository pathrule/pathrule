// SPDX-License-Identifier: Apache-2.0
// Example data for the playground only. Clearly fictional; never imported by the library or an
// app, and never shown as anyone's real runtime state.
import type {
  CorrectionOutcome,
  EnvironmentCoverage,
  IngestKeySummary,
  ReleaseCoverage,
  SignalHistoryEntry,
  SignalIssue,
  SignalsSource,
} from "../src/signals/index.js";

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const hoursBack = (count: number, gapEvery = 0) =>
  Array.from({ length: count }, (_, i) => i)
    .filter((i) => !gapEvery || i % gapEvery !== 0)
    .map((i) => new Date(Math.floor((now - i * 3_600_000) / 3_600_000) * 3_600_000).toISOString());

function issue(overrides: Partial<SignalIssue> & { id: string }): SignalIssue {
  return {
    kind: "error",
    label: null,
    message: null,
    stack: null,
    fingerprint: `example-${overrides.id}`,
    environment: "production",
    release: "example-web@2026.10.3",
    flow: null,
    declaredPath: null,
    resolvedPath: null,
    mapping: "resolved",
    occurrences: 1,
    releaseOccurrences: 1,
    firstSeen: ago(200),
    lastSeen: ago(2),
    releaseFirstSeen: ago(30),
    status: "active",
    verification: "unobserved",
    coverage: { tracked: true },
    evidence: null,
    workflow: { handoff: true, handoffAt: ago(190), manualResolution: false },
    compacted: false,
    ...overrides,
  };
}

export const EXAMPLE_ISSUES: SignalIssue[] = [
  issue({
    id: "a",
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    stack:
      "at OrderList (src/features/orders/OrderList.tsx:42:18)\nat renderWithHooks (react-dom.js:15486:18)",
    declaredPath: "src/features/orders/OrderList.tsx",
    resolvedPath: "/src/features/orders",
    flow: "orders.list",
    occurrences: 1284,
    releaseOccurrences: 18,
    verification: "recurred",
    evidence: {
      reason: "fingerprint_recurred",
      release: "example-web@2026.10.3",
      startedAt: ago(30),
      updatedAt: ago(2),
      details: {},
    },
  }),
  issue({
    id: "b",
    message: "UnauthorizedError: token refresh raced logout <img src=x onerror=alert(1)>",
    declaredPath: "src/features/auth/useSession.ts",
    resolvedPath: "/src/features/auth",
    occurrences: 312,
    releaseOccurrences: 0,
    verification: "observing",
    evidence: {
      reason: "new_release_seen",
      release: "example-web@2026.10.3",
      startedAt: ago(20),
      updatedAt: ago(20),
      details: {},
    },
  }),
  issue({
    id: "c",
    message: "RangeError: Invalid time value in formatDate",
    resolvedPath: "/src/lib/date",
    occurrences: 88,
    verification: "quiet",
    lastSeen: ago(96),
    evidence: {
      reason: "healthy_silence",
      release: "example-web@2026.10.3",
      startedAt: ago(120),
      updatedAt: ago(10),
      details: { coverage_hours: "31" },
    },
  }),
  issue({
    id: "d",
    message: "ZodError: invalid payload for orders.create",
    resolvedPath: "/src/server/routers",
    occurrences: 41,
    status: "resolved",
    verification: "verified",
    lastSeen: ago(260),
    evidence: {
      reason: "same_flow_success",
      release: "example-web@2026.10.2",
      startedAt: ago(400),
      updatedAt: ago(250),
      details: { successes: "12" },
    },
  }),
  issue({
    id: "e",
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    fingerprint: "example-a",
    environment: "staging",
    release: "example-web@2026.10.4-rc1",
    resolvedPath: "/src/features/orders",
    occurrences: 9,
    coverage: { tracked: false, reason: "verification runs for production errors only" },
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
  }),
  issue({
    id: "f",
    kind: "event",
    label: "checkout.completed",
    message: null,
    occurrences: 5120,
    releaseOccurrences: 640,
    coverage: { tracked: false, reason: "events are success evidence, not verified themselves" },
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
  }),
];

export const EXAMPLE_COVERAGE: EnvironmentCoverage[] = [
  {
    environment: "production",
    release: "example-web@2026.10.3",
    connectedAt: ago(900),
    lastSeen: ago(0.2),
    heartbeats: 1840,
    coverageHours: hoursBack(72, 0),
    coverageDays: [],
  },
  {
    environment: "staging",
    release: "example-web@2026.10.4-rc1",
    connectedAt: ago(500),
    lastSeen: ago(3),
    heartbeats: 64,
    coverageHours: hoursBack(40, 3),
    coverageDays: [],
  },
  {
    environment: "preview",
    release: null,
    connectedAt: ago(700),
    lastSeen: ago(200),
    heartbeats: 2,
    coverageHours: [],
    coverageDays: [],
  },
];

export const EXAMPLE_KEYS: IngestKeySummary[] = [
  {
    id: "k1",
    prefix: "pr_ing_ex1",
    label: "production",
    createdAt: ago(900),
    lastUsedAt: ago(0.1),
    revokedAt: null,
  },
  {
    id: "k2",
    prefix: "pr_ing_ex2",
    label: "old",
    createdAt: ago(2000),
    lastUsedAt: ago(1500),
    revokedAt: ago(1400),
  },
];

/** Local-runtime-shaped groups: fix records, per-field evidence, a declared point. */
export const EXAMPLE_LOCAL_ISSUES: SignalIssue[] = [
  issue({
    id: "l1",
    message: "TypeError: Cannot read properties of undefined (reading 'token')",
    label: "TypeError",
    flow: "login",
    declaredPath: "/src/api",
    resolvedPath: "/src/api",
    release: "example-api@1.4.1",
    occurrences: 64,
    verification: "observing",
    revision: 3,
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
    metadata: { route: "/session/refresh", region: "example" },
    correction: {
      attemptId: "example-fix-1",
      recordedAt: ago(30),
      baselineRelease: "example-api@1.4.0",
      note: "Example note: guard the refresh race <script>ignored</script>",
      actor: "example agent",
      knowledgeRefs: [],
    },
    progress: {
      candidateRelease: "example-api@1.4.1",
      observedSince: ago(20),
      updatedAt: ago(1),
      envelopes: 2,
      successes: 1,
      recurrences: 0,
      recurredRelease: null,
      candidateLastSeen: ago(0.2),
      fresh: null,
      blocked: null,
    },
  }),
  issue({
    id: "l2",
    message: "Error: payment provider timed out",
    label: "Error",
    flow: "checkout",
    declaredPath: "/src/pay",
    resolvedPath: null,
    mapping: "unmapped",
    release: null,
    occurrences: 7,
    revision: 2,
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
    correction: {
      attemptId: "example-fix-2",
      recordedAt: ago(5),
      baselineRelease: null,
      note: null,
      actor: "Local Console",
      knowledgeRefs: [],
    },
    progress: {
      candidateRelease: null,
      observedSince: null,
      updatedAt: ago(5),
      envelopes: 0,
      successes: 0,
      recurrences: 0,
      recurredRelease: null,
      candidateLastSeen: null,
      fresh: null,
      blocked: "no_release",
    },
  }),
  issue({
    id: "l3",
    message: "RangeError: Invalid time value",
    label: "RangeError",
    status: "archived",
    verification: "quiet",
    release: "example-api@1.3.9",
    occurrences: 3,
    revision: 4,
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
  }),
  issue({
    id: "l4",
    kind: "error",
    status: "declared",
    message: null,
    label: null,
    flow: "import",
    declaredPath: "/src/importer",
    resolvedPath: "/src/importer",
    occurrences: 0,
    revision: 1,
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
  }),
];

export const EXAMPLE_RELEASES: ReleaseCoverage[] = [
  {
    environment: "production",
    release: "example-api@1.4.1",
    envelopes: 2,
    firstSeen: ago(20),
    lastSeen: ago(0.2),
  },
  {
    environment: "production",
    release: "example-api@1.4.0",
    envelopes: 318,
    firstSeen: ago(300),
    lastSeen: ago(21),
  },
  {
    environment: "development",
    release: null,
    envelopes: 12,
    firstSeen: ago(50),
    lastSeen: ago(4),
  },
];

const EXAMPLE_HISTORY: SignalHistoryEntry[] = [
  {
    event: "transition",
    at: ago(20),
    from: "unobserved",
    to: "observing",
    release: "example-api@1.4.1",
    attemptId: "example-fix-1",
  },
  {
    event: "correction",
    at: ago(30),
    from: "recurred",
    to: "unobserved",
    release: "example-api@1.4.0",
    attemptId: "example-fix-1",
  },
];

export type ExampleMode = "local" | "data" | "empty" | "error" | "unavailable";

export function exampleSource(mode: ExampleMode): SignalsSource {
  const delay = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 250));
  if (mode === "local") {
    return {
      capabilities: {
        read: true,
        coverage: true,
        ingestKeys: { list: false, create: false, revoke: false },
        usage: false,
        history: true,
        corrections: true,
        releases: true,
        workflow: false,
        policy: {
          minEnvelopes: 3,
          quietAfterMs: 24 * 3_600_000,
          verifiedAfterMs: 3_600_000,
          minSuccesses: 3,
          freshnessMs: 45 * 60_000,
        },
        retention: "Example: what the source keeps and for how long, in a sentence.",
      },
      listIssues: () => delay({ issues: EXAMPLE_LOCAL_ISSUES, truncated: false }),
      listCoverage: () =>
        delay([
          {
            environment: "production",
            release: "example-api@1.4.1",
            connectedAt: ago(300),
            lastSeen: ago(0.2),
            heartbeats: null,
            envelopes: 2,
            coverageHours: null,
            coverageDays: null,
          },
        ]),
      listReleases: () => delay(EXAMPLE_RELEASES),
      getHistory: (issue) => delay(issue.id === "l1" ? EXAMPLE_HISTORY : []),
      // The playground records nothing: it answers as the runtime would, for the demo only.
      recordCorrection: (issue): Promise<CorrectionOutcome> => delay({ status: "recorded", issue }),
    };
  }
  if (mode === "unavailable") {
    return {
      capabilities: {
        read: false,
        unavailableReason:
          "The local runtime has no runtime event store. Runtime events are ingested by Pathrule Cloud.",
        coverage: false,
        ingestKeys: { list: false, create: false, revoke: false },
        usage: false,
      },
      listIssues: async () => [],
    };
  }
  return {
    capabilities: {
      read: true,
      coverage: true,
      ingestKeys: { list: true, create: false, revoke: true },
      usage: false,
    },
    listIssues: () =>
      mode === "error"
        ? Promise.reject(new Error("permission denied for runtime events (example)"))
        : delay(mode === "empty" ? [] : EXAMPLE_ISSUES),
    listCoverage: () => delay(mode === "empty" ? [] : EXAMPLE_COVERAGE),
    listKeys: () => delay(mode === "empty" ? [] : EXAMPLE_KEYS),
    revokeKey: () => delay(undefined),
  };
}
