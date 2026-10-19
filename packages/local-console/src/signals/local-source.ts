// SPDX-License-Identifier: Apache-2.0
// The Signals Workspace's Pathrule Local source: runtime event groups the host stores for one local
// workspace (sent by the SDK's `pathruleLocal()` destination), read through `pathrule ui`'s
// loopback API. The runtime computes every lifecycle field; this adapter only maps the
// provider-neutral contract (@pathrule/protocol/runtime-events) into the shared view model.
//
// Nothing here leaves the machine, and nothing here is sample data: every value is what the
// local store answered. Application text stays untrusted and is rendered as text by the UI.
import type { LocalWorkspaceSummary } from "@pathrule/protocol/local-ui-api.js";
import {
  RUNTIME_VERIFICATION_POLICY,
  isRuntimeVerificationFresh,
  type RuntimeEventGroup,
  type RuntimeEventsStatus,
} from "@pathrule/protocol/runtime-events.js";
import type {
  EnvironmentCoverage,
  ReleaseCoverage,
  SignalIssue,
  SignalsCapabilities,
  SignalsSource,
  VerificationPolicy,
} from "@pathrule/ui/signals";
import type { LocalApi } from "../api/client.js";

export const LOCAL_VERIFICATION_POLICY: VerificationPolicy = {
  minEnvelopes: RUNTIME_VERIFICATION_POLICY.minReleaseEnvelopes,
  quietAfterMs: RUNTIME_VERIFICATION_POLICY.quietMinObservationMs,
  verifiedAfterMs: RUNTIME_VERIFICATION_POLICY.verifiedMinObservationMs,
  minSuccesses: RUNTIME_VERIFICATION_POLICY.verifiedMinSuccesses,
  freshnessMs: RUNTIME_VERIFICATION_POLICY.freshnessMs,
};

export interface LocalSignalsText {
  /** Why an event group is not verified itself. */
  eventsNotVerified: string;
  /** What the local store keeps, in a sentence. */
  retention: string;
}

/** A workspace path as the tree knows it, for telling a mapped node from an unknown path. */
function treePaths(nodes: ReadonlyArray<{ relativePath: string | null }>): Set<string> {
  const paths = new Set<string>(["/"]);
  for (const node of nodes) {
    const path = node.relativePath && node.relativePath !== "" ? node.relativePath : "/";
    paths.add(path);
  }
  return paths;
}

export function toSignalIssue(
  group: RuntimeEventGroup,
  options: { paths: ReadonlySet<string> | null; now: number; text: LocalSignalsText },
): SignalIssue {
  const metadata = group.metadata ? { ...group.metadata } : null;
  const stackValue = metadata?.stack;
  const stack = typeof stackValue === "string" && stackValue.trim() ? stackValue : null;
  if (metadata) delete metadata.stack;
  const v = group.verification;
  const mapped = group.nodePath && options.paths ? options.paths.has(group.nodePath) : null;
  return {
    id: group.id,
    kind: group.kind,
    label: group.label,
    message: group.message,
    stack,
    fingerprint: group.fingerprint,
    environment: group.environment,
    release: group.release,
    flow: group.flow,
    declaredPath: group.nodePath,
    resolvedPath: mapped ? group.nodePath : null,
    mapping: group.nodePath && mapped !== null ? (mapped ? "resolved" : "unmapped") : null,
    occurrences: group.occurrenceCount,
    releaseOccurrences: group.releaseOccurrenceCount,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    releaseFirstSeen: null,
    status: group.status,
    verification: v.state,
    coverage:
      group.kind === "event"
        ? { tracked: false, reason: options.text.eventsNotVerified }
        : { tracked: true },
    evidence: null,
    // Pathrule Local keeps no hand-off records; a fix record is the only human input.
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
    compacted: false,
    revision: group.revision,
    metadata: metadata && Object.keys(metadata).length ? metadata : null,
    correction: group.correction
      ? {
          attemptId: group.correction.attemptId,
          recordedAt: group.correction.recordedAt,
          baselineRelease: group.correction.baselineRelease,
          note: group.correction.note,
          actor: group.correction.actor,
          knowledgeRefs: group.correction.knowledgeRefs,
        }
      : null,
    progress: group.correction
      ? {
          candidateRelease: v.candidateRelease,
          observedSince: v.observationStartedAt,
          updatedAt: v.updatedAt,
          envelopes: v.evidence.candidateEnvelopes,
          successes: v.evidence.successes,
          recurrences: v.evidence.recurrences,
          recurredRelease: v.evidence.recurredRelease,
          candidateLastSeen: v.evidence.candidateLastSeenAt,
          fresh: isRuntimeVerificationFresh(v, options.now),
          blocked: v.blockedReason,
        }
      : null,
  };
}

/** Per environment: the release that sent last, its envelopes, and the span the runtime saw. */
export function environmentCoverage(status: RuntimeEventsStatus): EnvironmentCoverage[] {
  const byEnvironment = new Map<string, RuntimeEventsStatus["releases"]>();
  for (const row of status.releases) {
    byEnvironment.set(row.environment, [...(byEnvironment.get(row.environment) ?? []), row]);
  }
  return [...byEnvironment.entries()]
    .map(([environment, rows]) => {
      const latest = rows.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]!;
      return {
        environment,
        release: latest.release,
        connectedAt: rows.map((r) => r.firstSeen).sort()[0] ?? null,
        lastSeen: latest.lastSeen,
        heartbeats: null,
        envelopes: latest.envelopes,
        // The local store counts envelopes per release; it does not bucket them by hour.
        coverageHours: null,
        coverageDays: null,
      };
    })
    .sort((a, b) => a.environment.localeCompare(b.environment));
}

export function releaseCoverage(status: RuntimeEventsStatus): ReleaseCoverage[] {
  return status.releases.map((row) => ({
    environment: row.environment,
    release: row.release,
    envelopes: row.envelopes,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
  }));
}

export function localSignalsSource(input: {
  api: LocalApi;
  workspace: LocalWorkspaceSummary;
  capability: { available: true } | { available: false; reason: string };
  text: LocalSignalsText;
  now?: () => number;
}): SignalsSource {
  const { api, workspace, text } = input;
  const now = input.now ?? Date.now;
  const workspaceId = workspace.id;
  let paths: Set<string> | null = null;
  // One status read serves coverage and releases of the same refresh.
  let status: { at: number; answer: Promise<RuntimeEventsStatus> } | null = null;
  const readStatus = () => {
    if (!status || now() - status.at > 1_000) {
      const answer = api.call("signals.status", { workspaceId }).then((r) => r.status);
      answer.catch(() => {
        status = null;
      });
      status = { at: now(), answer };
    }
    return status.answer;
  };
  const map = (group: RuntimeEventGroup) => toSignalIssue(group, { paths, now: now(), text });

  const capabilities: SignalsCapabilities = input.capability.available
    ? {
        read: true,
        coverage: true,
        ingestKeys: { list: false, create: false, revoke: false },
        usage: false,
        history: true,
        corrections: true,
        releases: true,
        workflow: false,
        policy: LOCAL_VERIFICATION_POLICY,
        retention: text.retention,
      }
    : {
        read: false,
        unavailableReason: input.capability.reason,
        coverage: false,
        ingestKeys: { list: false, create: false, revoke: false },
        usage: false,
      };

  return {
    capabilities,
    async listIssues(signal) {
      const [listed, tree] = await Promise.all([
        api.call("signals.groups", { workspaceId }, signal),
        api.call("tree.get", { workspaceId }, signal).catch(() => null),
      ]);
      paths = tree ? treePaths(tree.nodes) : null;
      return { issues: listed.groups.map(map), truncated: listed.truncated };
    },
    async listCoverage() {
      return environmentCoverage(await readStatus());
    },
    async listReleases() {
      return releaseCoverage(await readStatus());
    },
    async getHistory(issue, signal) {
      const answer = await api.call("signals.group", { workspaceId, groupId: issue.id }, signal);
      return answer.history.map((entry) => ({
        event: entry.event,
        at: entry.at,
        from: entry.from,
        to: entry.to,
        release: entry.release,
        attemptId: entry.attemptId,
      }));
    },
    async recordCorrection(issue, correction) {
      if (issue.revision == null) {
        return { status: "refused", reason: "invalid", issue: null };
      }
      const answer = await api.call("signals.correction", {
        workspaceId,
        groupId: issue.id,
        expectedRevision: issue.revision,
        idempotencyKey: correction.idempotencyKey,
        ...(correction.baselineRelease ? { baselineRelease: correction.baselineRelease } : {}),
        ...(correction.note ? { note: correction.note } : {}),
      });
      const mapped = answer.group ? map(answer.group) : null;
      return answer.status === "refused"
        ? { status: "refused", reason: answer.reason, issue: mapped }
        : { status: answer.status, issue: mapped };
    },
  };
}
