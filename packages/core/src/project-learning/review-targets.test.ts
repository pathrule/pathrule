// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { retainReviewTargets } from "./review-targets.js";
import { projectMapContext } from "./context.js";
import type { ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";

const digest = `git:${"a".repeat(40)}`;
const changedDigest = `git:${"b".repeat(40)}`;
function snapshot(paths: string[]): ProjectMapSnapshot {
  return {
    version: 1,
    rootKey: "root",
    observedAt: "2026-09-28T00:00:00Z",
    head: "head",
    phase: "initial",
    inventory: "git",
    consistency: "stable",
    files: paths.map((path) => ({
      path,
      digest,
      language: "typescript",
      kind: "source",
      observation: "indexed",
    })),
    coverage: {
      inventoryComplete: true,
      listedFiles: paths.length,
      capturedFiles: paths.length,
      unavailableFiles: 0,
      reusedManifests: 0,
      readBytes: 0,
    },
    changes: { added: 0, changed: 0, removed: 0 },
  };
}
describe("continuous review targets", () => {
  it("retains an unreviewed change across quiet scans and suppresses only matching verified evidence", () => {
    const original = snapshot(["src/a.ts", "src/b.ts"]);
    Object.assign(original, retainReviewTargets(original));
    const changed = snapshot(["src/a.ts", "src/b.ts"]);
    changed.files[1]!.digest = changedDigest;
    Object.assign(changed, retainReviewTargets(changed, original));
    const quiet = { ...changed, ...retainReviewTargets(changed, changed) };
    expect(quiet.reviewTargets?.[0]).toEqual({
      path: "src/b.ts",
      digest: changedDigest,
      reason: "changed",
    });
    expect(
      projectMapContext(quiet, "/src", true, [{ path: "src/b.ts", digest }]).reviewTargets,
    ).toHaveLength(2);
    expect(
      projectMapContext(quiet, "/src", true, [{ path: "src/b.ts", digest: changedDigest }])
        .reviewTargets,
    ).toEqual([{ path: "src/a.ts", digest, reason: "initial" }]);
    expect(projectMapContext(quiet, "/other").reviewTargets).toEqual([]);
  });

  it("does not call a missing file deleted until the inventory is complete and stable", () => {
    const old = snapshot(["src/a.ts"]);
    Object.assign(old, retainReviewTargets(old));
    const partial = snapshot([]);
    partial.coverage.inventoryComplete = false;
    expect(retainReviewTargets(partial, old).reviewTargets?.[0]?.reason).toBe("initial");
    const deleted = snapshot([]);
    Object.assign(deleted, retainReviewTargets(deleted, old));
    expect(deleted.reviewTargets).toEqual([{ path: "src/a.ts", reason: "removed" }]);
    expect(retainReviewTargets(deleted, deleted).reviewTargets).toEqual(deleted.reviewTargets);
    expect(retainReviewTargets(old, deleted).reviewTargets?.[0]?.reason).toBe("added");
  });

  it("bounds the backlog, prioritizes new changes and makes missing coverage explicit", () => {
    const old = snapshot(Array.from({ length: 250 }, (_, i) => `src/${i}.ts`));
    Object.assign(old, retainReviewTargets(old));
    expect(old.reviewTargets).toHaveLength(200);
    expect(old.reviewTargetsTruncated).toBe(true);
    const next = snapshot(old.files.map((file) => file.path));
    next.files[249]!.digest = changedDigest;
    Object.assign(next, retainReviewTargets(next, old));
    const view = projectMapContext(next);
    expect(view.reviewTargets?.[0]?.path).toBe("src/249.ts");
    expect(view.reviewTargetsTruncated).toBe(true);
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(6000);
    const verified = next
      .reviewTargets!.slice(0, 8)
      .map((target) => ({ path: target.path, digest: target.digest! }));
    expect(projectMapContext(next, "/", true, verified).reviewTargets?.[0]?.path).not.toBe(
      view.reviewTargets?.[0]?.path,
    );
  });
});
