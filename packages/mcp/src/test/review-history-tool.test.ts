// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  read: vi.fn(async (_options: unknown) => ({ status: "unavailable", evidence: [] })),
  claims: vi.fn(async () => [{ reviewSources: [{ digest: "sha256:observed" }] }]),
  match: vi.fn(async () => ({ workspaceId: "ws", localRootPath: "/repo" })),
}));
vi.mock("@pathrule/core/project-learning/review-history.js", () => ({
  readReviewHistory: state.read,
}));
vi.mock("../tools/helpers.js", () => ({
  resolveWorkspaceTarget: async () => ({
    ok: true,
    workspaceId: "ws",
    ctx: {
      backend: {
        resolveWorkspaceFromCwd: state.match,
        listLearningClaims: state.claims,
      },
    },
  }),
}));
import { reviewHistoryTool } from "../tools/review-history.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.match.mockResolvedValue({ workspaceId: "ws", localRootPath: "/repo" });
});
describe("review history tool", () => {
  it("uses the bound checkout and skips already synthesized excerpts while retaining fallback status", async () => {
    const result = await reviewHistoryTool.handler({ cwd: "/repo/src", pull_numbers: [12] });
    expect(state.read).toHaveBeenCalledWith({
      workspaceId: "ws",
      localRootPath: "/repo",
      pullNumbers: [12],
      page: undefined,
      knownDigests: ["sha256:observed"],
    });
    expect(result).toMatchObject({ ok: true, status: "unavailable", evidence: [] });
  });
  it("allows explicit rereading but refuses a changed workspace binding", async () => {
    await reviewHistoryTool.handler({ cwd: "/repo", include_seen: true });
    expect(state.claims).not.toHaveBeenCalled();
    expect(state.read).toHaveBeenCalledWith(expect.objectContaining({ knownDigests: [] }));
    state.read.mockClear();
    state.match.mockResolvedValueOnce({ workspaceId: "other", localRootPath: "/other" });
    expect(await reviewHistoryTool.handler({ cwd: "/repo" })).toMatchObject({ ok: false });
    expect(state.read).not.toHaveBeenCalled();
  });
});
