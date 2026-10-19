// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
// Lives here rather than in @pathrule/core: the shared activity writer is typed against the
// cloud tool context, so it cannot enter the open-source core closure. The MCP server is
// the consumer that composes that writer with the local backend.
import { LocalBackend } from "@pathrule/core";
import { normalizeFilesTouched } from "@pathrule/protocol/normalize-workspace-path.js";
import { writeActivityLog } from "@pathrule/core/tools/activity-log.js";
import { buildActivityLeads } from "@pathrule/core/activity/activity-leads.js";

describe("activity evidence through the real local writer", () => {
  it("preserves origin and identity, reports the 60-file cap, and isolates workspaces", async () => {
    const backend = new LocalBackend(":memory:");
    try {
      const files = normalizeFilesTouched(
        { by_area: { code: Array.from({ length: 65 }, (_, i) => `/repo/src/f${i}.ts`) } },
        "/repo",
      ).normalized;
      const record = await writeActivityLog(
        { backend, userId: "", workspaceId: "one" },
        {
          workspaceId: "one",
          nodePath: "/src",
          domain: "backend",
          action: "update",
          scope: "service",
          subjects: [],
          taskSummary: "Fix the bug",
          filesTouched: files,
          provenance: {
            version: 1,
            summarySource: "user_intent",
            filesSource: "observed_tools",
            threadId: "thread",
            turnId: "turn",
            observedFileCount: 65,
            storedFileCount: 65,
            filesTruncated: false,
            outcome: "unknown",
          },
        },
      );
      expect(record.provenance).toMatchObject({
        threadId: "thread",
        turnId: "turn",
        storedFileCount: 60,
        observedFileCount: 65,
        filesTruncated: true,
        outcome: "unknown",
      });
      const rows = await backend.learningActivities("one");
      expect(rows[0]?.provenance).toEqual(record.provenance);
      expect(rows[0]).not.toHaveProperty("taskSummary");
      expect(await backend.learningActivities("two")).toEqual([]);
      expect(buildActivityLeads(rows).targets[0]?.needs).toBe("source_verification");
    } finally {
      backend.close();
    }
  });

  it("keeps pre-provenance activity usable without inventing its origin", async () => {
    const backend = new LocalBackend(":memory:");
    try {
      await backend.logActivity({
        workspaceId: "ws",
        domain: "backend",
        action: "fix",
        scope: "service",
        taskSummary: "fixed",
        filesTouched: normalizeFilesTouched({ by_area: { code: ["src/a.ts"] } }, "/repo")
          .normalized,
      });
      const rows = await backend.learningActivities("ws");
      expect(rows[0]?.provenance).toBeUndefined();
      expect(buildActivityLeads(rows).targets[0]?.summarySources).toEqual(["unknown"]);
    } finally {
      backend.close();
    }
  });
});
