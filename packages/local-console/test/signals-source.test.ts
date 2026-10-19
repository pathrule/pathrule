// SPDX-License-Identifier: Apache-2.0
import type { RuntimeEventGroup } from "@pathrule/protocol/runtime-events.js";
import { describe, expect, it, vi } from "vitest";
import type { LocalApi } from "../src/api/client.js";
import {
  LOCAL_VERIFICATION_POLICY,
  environmentCoverage,
  localSignalsSource,
  toSignalIssue,
} from "../src/signals/local-source.js";

const text = { eventsNotVerified: "events are evidence", retention: "kept locally" };
const NOW = Date.parse("2026-10-09T12:00:00.000Z");

function group(overrides: Partial<RuntimeEventGroup> = {}): RuntimeEventGroup {
  return {
    id: "g1",
    workspaceId: "ws",
    environment: "production",
    kind: "error",
    fingerprint: "fp",
    status: "active",
    nodePath: "/src/api",
    label: "TypeError",
    flow: "login",
    release: "1.0.0",
    message: "boom",
    metadata: { stack: "at a (b.ts:1:1)", route: "/pay" },
    occurrenceCount: 3,
    releaseOccurrenceCount: 1,
    firstSeen: "2026-10-01T00:00:00.000Z",
    lastSeen: "2026-10-09T00:00:00.000Z",
    revision: 1,
    verification: {
      state: "unobserved",
      candidateRelease: null,
      observationStartedAt: null,
      updatedAt: null,
      evidence: {
        candidateEnvelopes: 0,
        candidateLastSeenAt: null,
        successes: 0,
        recurrences: 0,
        recurredRelease: null,
      },
      blockedReason: null,
    },
    correction: null,
    ...overrides,
  };
}

describe("the Local Signals adapter", () => {
  it("maps the runtime's group as stated: the stack from metadata, the path checked against the tree", () => {
    const issue = toSignalIssue(group(), { paths: new Set(["/", "/src/api"]), now: NOW, text });
    expect(issue).toMatchObject({
      status: "active",
      verification: "unobserved",
      stack: "at a (b.ts:1:1)",
      metadata: { route: "/pay" },
      declaredPath: "/src/api",
      resolvedPath: "/src/api",
      mapping: "resolved",
      coverage: { tracked: true },
      revision: 1,
      correction: null,
      progress: null,
      workflow: { handoff: false, manualResolution: false },
    });
    const unknown = toSignalIssue(group({ nodePath: "/gone" }), {
      paths: new Set(["/"]),
      now: NOW,
      text,
    });
    expect(unknown).toMatchObject({
      resolvedPath: null,
      mapping: "unmapped",
      declaredPath: "/gone",
    });
    // Without the tree nothing is claimed either way.
    expect(toSignalIssue(group(), { paths: null, now: NOW, text }).mapping).toBeNull();
  });

  it("an event is evidence, never verified itself; a fix record brings its progress", () => {
    expect(
      toSignalIssue(group({ kind: "event" }), { paths: null, now: NOW, text }).coverage,
    ).toEqual({
      tracked: false,
      reason: "events are evidence",
    });
    const quiet = toSignalIssue(
      group({
        verification: {
          state: "quiet",
          candidateRelease: "1.1.0",
          observationStartedAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-09T00:00:00.000Z",
          evidence: {
            candidateEnvelopes: 5,
            candidateLastSeenAt: "2026-10-09T08:00:00.000Z",
            successes: 0,
            recurrences: 0,
            recurredRelease: null,
          },
          blockedReason: null,
        },
        correction: {
          attemptId: "a1",
          recordedAt: "2026-10-07T00:00:00.000Z",
          baselineRelease: "1.0.0",
          note: null,
          knowledgeRefs: [],
          actor: "agent",
        },
      }),
      { paths: null, now: NOW, text },
    );
    // Quiet only stands while the release keeps sending: 4 hours of silence is stale.
    expect(quiet.progress).toMatchObject({ candidateRelease: "1.1.0", envelopes: 5, fresh: false });
    expect(LOCAL_VERIFICATION_POLICY).toMatchObject({ minEnvelopes: 3, minSuccesses: 3 });
  });

  it("reads coverage per environment from the release rows", () => {
    expect(
      environmentCoverage({
        source: "local",
        connected: true,
        lastSeen: "2026-10-09T10:00:00.000Z",
        activeCount: 0,
        declaredCount: 0,
        groupCount: 0,
        releases: [
          {
            environment: "production",
            release: "1.0.0",
            envelopes: 2,
            firstSeen: "2026-10-01T00:00:00.000Z",
            lastSeen: "2026-10-05T00:00:00.000Z",
          },
          {
            environment: "production",
            release: "1.1.0",
            envelopes: 4,
            firstSeen: "2026-10-06T00:00:00.000Z",
            lastSeen: "2026-10-09T10:00:00.000Z",
          },
          {
            environment: "development",
            release: null,
            envelopes: 9,
            firstSeen: "2026-10-02T00:00:00.000Z",
            lastSeen: "2026-10-03T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        environment: "development",
        release: null,
        envelopes: 9,
        coverageHours: null,
      }),
      expect.objectContaining({
        environment: "production",
        release: "1.1.0",
        envelopes: 4,
        connectedAt: "2026-10-01T00:00:00.000Z",
        heartbeats: null,
      }),
    ]);
  });

  it("records a fix with the revision it read and the attempt's key, and passes a refusal through", async () => {
    const call = vi.fn(async () => ({
      status: "refused",
      reason: "revision_conflict",
      group: group({ revision: 3 }),
    }));
    const source = localSignalsSource({
      api: { call } as unknown as LocalApi,
      workspace: { id: "ws", name: "w", rootPath: "/w", current: true },
      capability: { available: true },
      text,
      now: () => NOW,
    });
    const issue = toSignalIssue(group({ revision: 2 }), { paths: null, now: NOW, text });
    const outcome = await source.recordCorrection!(issue, {
      idempotencyKey: "console-1",
      note: "x",
    });
    expect(call).toHaveBeenCalledWith("signals.correction", {
      workspaceId: "ws",
      groupId: "g1",
      expectedRevision: 2,
      idempotencyKey: "console-1",
      note: "x",
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "revision_conflict",
      issue: { revision: 3 },
    });
  });

  it("is unavailable, with the runtime's reason, on a host without runtime events", () => {
    const source = localSignalsSource({
      api: { call: vi.fn() } as unknown as LocalApi,
      workspace: { id: "ws", name: "w", rootPath: "/w", current: true },
      capability: { available: false, reason: "host too old" },
      text,
    });
    expect(source.capabilities).toMatchObject({ read: false, unavailableReason: "host too old" });
  });
});
