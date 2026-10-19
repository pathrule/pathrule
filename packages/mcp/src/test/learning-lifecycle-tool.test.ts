// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryKnowledgeBackend } from "@pathrule/core";
const state = vi.hoisted(() => ({ backend: undefined as unknown, root: "", mismatch: false }));
vi.mock("../tools/helpers.js", () => ({
  resolveWorkspaceTarget: async () => ({
    ok: true,
    workspaceId: state.mismatch ? "other" : "ws",
    ctx: { backend: state.backend },
  }),
}));
import { recordLearningTool } from "../tools/record-learning.js";
import { reviewLearningTool } from "../tools/review-learning.js";
let directory: string;
const source = "export const store = 1;";
const args = {
  node_path: "/src",
  topic: "Storage",
  statement: "Initial finding.",
  category: "architecture" as const,
  sources: [
    { path: "src/a.ts", digest: `sha256:${createHash("sha256").update(source).digest("hex")}` },
  ],
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "learning-tools-"));
  state.root = join(directory, "repo");
  await mkdir(join(state.root, "src"), { recursive: true });
  await writeFile(join(state.root, "src/a.ts"), source);
  vi.stubEnv("PATHRULE_HOME", join(directory, "internal"));
  const backend = new InMemoryKnowledgeBackend();
  backend.registerWorkspace({ workspaceId: "ws", name: "test", localRootPath: state.root });
  state.backend = backend;
  state.mismatch = false;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
describe("learning inspection and correction tools", () => {
  it("checks sources before correction, exposes the replacement and durably retracts it", async () => {
    const first = (await recordLearningTool.handler({ ...args, cwd: state.root })) as {
      ok: boolean;
      id: string;
    };
    expect(first.ok).toBe(true);
    const bad = await recordLearningTool.handler({
      ...args,
      cwd: state.root,
      replaces_id: first.id,
      statement: "Correction.",
      sources: [{ ...args.sources[0]!, digest: `sha256:${"0".repeat(64)}` }],
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "source_verification_required" } });
    const corrected = (await recordLearningTool.handler({
      ...args,
      cwd: state.root,
      replaces_id: first.id,
      statement: "Correction.",
    })) as { id: string };
    expect(corrected.id).not.toBe(first.id);
    // No person approves anything: the correction is context as soon as it is recorded.
    const inspected = await reviewLearningTool.handler({
      cwd: state.root,
      action: "inspect",
      node_path: "/src",
    });
    expect(inspected).toMatchObject({ ok: true, claims: [{ id: corrected.id }] });
    expect(inspected).not.toHaveProperty("unreviewed");
    expect(
      await reviewLearningTool.handler({ cwd: state.root, action: "retract", id: corrected.id }),
    ).toMatchObject({ ok: true, status: "applied" });
    expect(await reviewLearningTool.handler({ cwd: state.root, action: "inspect" })).toMatchObject({
      claims: [],
    });
    expect(await recordLearningTool.handler({ ...args, cwd: state.root })).toMatchObject({
      ok: false,
    });
  });
  it("shows conflicting statements only in an explicit review section", async () => {
    await recordLearningTool.handler({ ...args, cwd: state.root });
    await recordLearningTool.handler({
      ...args,
      cwd: state.root,
      statement: "Alternative interpretation.",
    });
    const result = await reviewLearningTool.handler({ cwd: state.root, action: "inspect" });
    expect(result).toMatchObject({
      claims: [],
      withheld: [{ reason: "conflict" }, { reason: "conflict" }],
      inspection_candidates: {
        for_review_only: true,
        findings: [
          expect.objectContaining({ statement: "Alternative interpretation." }),
          expect.objectContaining({ statement: "Initial finding." }),
        ],
      },
    });
  });

  it("withholds a claim wherever its sources changed and serves it again once they match", async () => {
    const recorded = (await recordLearningTool.handler({ ...args, cwd: state.root })) as {
      id: string;
    };
    await writeFile(join(state.root, "src/a.ts"), "export const store = 2;");
    expect(await reviewLearningTool.handler({ cwd: state.root, action: "inspect" })).toMatchObject({
      claims: [],
      withheld: [{ id: recorded.id, reason: "stale" }],
    });
    await writeFile(join(state.root, "src/a.ts"), source);
    expect(await reviewLearningTool.handler({ cwd: state.root, action: "inspect" })).toMatchObject({
      claims: [{ id: recorded.id }],
      withheld: [],
    });
  });

  it("offers only inspect and retract, and never retracts for an unnamed action", async () => {
    const action = reviewLearningTool.inputSchema.action!;
    expect(["inspect", "retract", "approve"].map((a) => action.safeParse(a).success)).toEqual([
      true,
      true,
      false,
    ]);
    const recorded = (await recordLearningTool.handler({ ...args, cwd: state.root })) as {
      id: string;
    };
    // A caller that skips schema validation must not fall through to the retraction.
    expect(
      await reviewLearningTool.handler({
        cwd: state.root,
        action: "approve" as never,
        id: recorded.id,
      }),
    ).toMatchObject({ ok: false });
    expect(await reviewLearningTool.handler({ cwd: state.root, action: "inspect" })).toMatchObject({
      claims: [{ id: recorded.id }],
    });
  });

  it("refuses workspace mismatch and storage inside the source repo", async () => {
    state.mismatch = true;
    expect(await reviewLearningTool.handler({ cwd: state.root, action: "inspect" })).toMatchObject({
      ok: false,
    });
    state.mismatch = false;
    vi.stubEnv("PATHRULE_HOME", join(state.root, "internal"));
    expect(
      await reviewLearningTool.handler({ cwd: state.root, action: "retract", id: "a".repeat(64) }),
    ).toMatchObject({ ok: false });
  });
});
