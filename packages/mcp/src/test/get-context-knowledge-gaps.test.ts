// SPDX-License-Identifier: Apache-2.0
// get_context names no knowledge gap: nothing open decides which gaps are open, so the learning
// fields never carry the field, with gap delivery switched on or not.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pathrule/core/project-learning/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pathrule/core/project-learning/index.js")>()),
  readLearningStamp: async () => "",
  refreshProjectMap: async () => undefined,
}));
vi.mock("@pathrule/core/project-learning/claim-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pathrule/core/project-learning/claim-service.js")>()),
  loadLearningContext: async () => undefined,
}));

import { loadProjectLearningFields, setProjectLearningBudgetForTest } from "../tools/get-context-learning.js";

const backend = { learningActivities: async () => [] } as never;
const load = (scope = "/packages/cli") =>
  loadProjectLearningFields({ backend, workspaceId: "ws", localRootPath: "/repo", scope });

afterEach(() => setProjectLearningBudgetForTest(null));

describe("get_context knowledge gaps", () => {
  it("names nothing: the field is absent", async () => {
    setProjectLearningBudgetForTest(5_000);
    const saved = process.env.PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED;
    process.env.PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED = "true";
    try {
      expect(await load()).not.toHaveProperty("knowledge_gaps");
      expect(await load("/")).not.toHaveProperty("knowledge_gaps");
    } finally {
      if (saved === undefined) delete process.env.PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED;
      else process.env.PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED = saved;
    }
  });
});
