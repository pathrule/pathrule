// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildActivityLeads,
  normalizeActivityProvenance,
  type ActivityLeadSource,
} from "./activity-leads.js";
import { normalizeFilesTouched } from "@pathrule/protocol/normalize-workspace-path.js";

const activity = (id: string, paths: string[]): ActivityLeadSource => ({
  id,
  createdAt: "2026-09-28T10:00:00Z",
  filesTouched: normalizeFilesTouched({ by_area: { code: paths } }, "/repo").normalized,
});

describe("activity-based project learning", () => {
  it("starts honestly with no model and no history", () => {
    expect(buildActivityLeads([])).toMatchObject({
      phase: "cold_start",
      targets: [],
      evidenceStatus: "activity_only",
    });
  });

  it("does not turn a successful-sounding record into verified knowledge", () => {
    const p = normalizeActivityProvenance({
      version: 1,
      summarySource: "user_intent",
      filesSource: "observed_tools",
      outcome: "succeeded",
      command: "secret",
      observedFileCount: 70,
      storedFileCount: 60,
    });
    expect(p).toMatchObject({
      outcome: "unknown",
      filesTruncated: true,
      summarySource: "user_intent",
    });
    expect(p).not.toHaveProperty("command");
    const context = buildActivityLeads([
      { ...activity("a", ["src/a.ts"]), provenance: p },
    ]);
    expect(context.targets[0]).toMatchObject({
      needs: "source_verification",
      summarySources: ["user_intent"],
    });
    expect(context.truncatedActivities).toBe(1);
  });

  it("isolates scopes by path segment and excludes secrets from review priorities", () => {
    const context = buildActivityLeads(
      [
        activity("a", [
          "packages/app/a.ts",
          "packages/application/b.ts",
          "packages/app/.env.local",
          "packages/app/.secrets/key.txt",
          "packages/app/cert.pem",
        ]),
      ],
      "/packages/app",
    );
    expect(context.targets.map((t) => t.path)).toEqual(["packages/app/a.ts"]);
  });

  it("never trusts raw legacy paths or turns unlocated history into cold start", () => {
    const raw = {
      ...activity("a", []),
      filesTouched: { by_area: { code: ["/Users/me/repo/a.ts"] } },
    };
    expect(buildActivityLeads([raw])).toMatchObject({
      phase: "incremental",
      targets: [],
      unlocatedActivities: 1,
    });
  });

  it("deduplicates repeated turn deliveries and keeps independent evidence", () => {
    const p = normalizeActivityProvenance({ version: 1, threadId: "thread", turnId: "turn" });
    const context = buildActivityLeads([
      { ...activity("a", ["src/a.ts"]), provenance: p },
      { ...activity("b", ["src/a.ts"]), provenance: p },
      activity("c", ["src/a.ts"]),
    ]);
    expect(context.sampledActivities).toBe(2);
    expect(context.targets[0]?.activityCount).toBe(2);
    expect(context.targets[0]?.activityRefs).toEqual(["a", "c"]);
  });
});
