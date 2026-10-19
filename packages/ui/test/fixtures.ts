// SPDX-License-Identifier: Apache-2.0
// Test fixtures only. Never imported by the library or an app.
import type { SignalIssue } from "../src/signals/model.js";

export function issue(overrides: Partial<SignalIssue> & { id: string }): SignalIssue {
  return {
    kind: "error",
    label: null,
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    stack: "at OrderList (src/features/orders/OrderList.tsx:42:18)",
    fingerprint: `fp-${overrides.id}`,
    environment: "production",
    release: "web@2026.10.3",
    flow: null,
    declaredPath: "src/features/orders/OrderList.tsx",
    resolvedPath: "/src/features/orders",
    mapping: "resolved",
    occurrences: 12,
    releaseOccurrences: 4,
    firstSeen: "2026-10-01T10:00:00.000Z",
    lastSeen: "2026-10-09T10:00:00.000Z",
    releaseFirstSeen: "2026-10-08T10:00:00.000Z",
    status: "active",
    verification: "unobserved",
    coverage: { tracked: true },
    evidence: null,
    workflow: { handoff: false, handoffAt: null, manualResolution: false },
    compacted: false,
    ...overrides,
  };
}
