// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  release: () => {},
  started: [] as string[],
}));
vi.mock("@pathrule/core/project-learning/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pathrule/core/project-learning/index.js")>();
  const gate = new Promise<void>((resolve) => (state.release = resolve));
  return {
    ...actual,
    readLearningStamp: async () => "",
    refreshProjectMap: vi.fn(async () => {
      state.started.push("map");
      await gate;
      return {
        status: "current",
        persisted: true,
        modules: [],
        sourceExamples: [],
        instruction: "map",
      };
    }),
  };
});
vi.mock("@pathrule/core/project-learning/claim-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pathrule/core/project-learning/claim-service.js")>();
  return {
    ...actual,
    loadLearningContext: vi.fn(async () => {
      state.started.push("claims");
      return {
        status: "available",
        scope: "/",
        claims: [],
        withheld: [],
        bounded: true,
        instruction: "",
      };
    }),
  };
});

import {
  loadProjectLearningFields,
  setProjectLearningBudgetForTest,
} from "../tools/get-context-learning.js";

afterEach(() => setProjectLearningBudgetForTest(null));

describe("get_context project learning budget", () => {
  it("loads in parallel, omits a slow map from this call and hands it to the next", async () => {
    setProjectLearningBudgetForTest(20);
    const backend = { learningActivities: async () => [] } as never;
    const input = { backend, workspaceId: "ws", localRootPath: "/repo", scope: "/" };
    const started = Date.now();
    expect(await loadProjectLearningFields(input)).toEqual({});
    expect(Date.now() - started).toBeLessThan(1_000);
    // Both loads were in flight together, not one after the other.
    expect(state.started.sort()).toEqual(["claims", "map"]);

    state.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = await loadProjectLearningFields(input);
    expect(next.project_map?.instruction).toBe("map");
    expect(next.project_learning_claims?.status).toBe("available");
  });
});
