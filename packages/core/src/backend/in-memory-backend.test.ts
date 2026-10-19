// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeBackend } from "./in-memory-backend.js";
import { runKnowledgeBackendContract, CONTRACT_TEST_EMBED } from "./contract-suite.js";

runKnowledgeBackendContract("InMemoryKnowledgeBackend", () => {
  let counter = 0;
  return new InMemoryKnowledgeBackend({
    genId: () => `id-${++counter}`,
    now: () => "2026-06-04T00:00:00.000Z",
    embed: CONTRACT_TEST_EMBED,
  });
});

// resolveWorkspaceFromCwd parity with LocalBackend (reference store).
describe("InMemory workspace resolution", () => {
  it("maps a cwd under a registered root; longest root wins; null when uncovered", async () => {
    const b = new InMemoryKnowledgeBackend();
    b.registerWorkspace({ workspaceId: "root", localRootPath: "/repo" });
    b.registerWorkspace({ workspaceId: "nested", localRootPath: "/repo/packages/api" });
    expect(await b.resolveWorkspaceFromCwd("/repo/src")).toMatchObject({
      workspaceId: "root",
      relativePath: "/src",
    });
    expect((await b.resolveWorkspaceFromCwd("/repo/packages/api/x"))?.workspaceId).toBe("nested");
    expect((await b.resolveWorkspaceFromCwd("/repo"))?.relativePath).toBe("");
    expect(await b.resolveWorkspaceFromCwd("/elsewhere")).toBeNull();
  });
});
