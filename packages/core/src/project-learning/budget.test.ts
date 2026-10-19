// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createBudgetedLoader, excludeVerifiedTargets } from "./budget.js";
import { createLearningClaim } from "./claim-service.js";

const later = <T>(value: T) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { run: async () => (await gate, value), release };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("budgeted project-learning loads", () => {
  it("returns null on a missed budget and serves the finished load next time (TTL mode)", async () => {
    const loader = createBudgetedLoader<string>(30_000);
    const slow = later("value");
    expect(await loader.load("k", "s1", slow.run, 5)).toBeNull();
    slow.release();
    await tick();
    let ran = false;
    const again = () => ((ran = true), Promise.resolve("fresh"));
    expect(await loader.load("k", "s1", again, 5)).toBe("value");
    expect(ran).toBe(false);
    // A new stamp (a claim changed) is never served from the older load.
    expect(await loader.load("k", "s2", again, 50)).toBe("fresh");
  });

  it("hands a late load to the next call once and otherwise never reuses (handoff mode)", async () => {
    const loader = createBudgetedLoader<string>(0);
    expect(await loader.load("k", "s", () => Promise.resolve("in-budget"), 50)).toBe("in-budget");
    expect(await loader.load("k", "s", () => Promise.resolve("reloaded"), 50)).toBe("reloaded");
    const slow = later("late");
    expect(await loader.load("k", "s", slow.run, 5)).toBeNull();
    slow.release();
    await tick();
    expect(await loader.load("k", "s", () => Promise.resolve("next"), 50)).toBe("late");
    expect(await loader.load("k", "s", () => Promise.resolve("next"), 50)).toBe("next");
  });

  it("never throws when the load rejects", async () => {
    const loader = createBudgetedLoader<string>(0);
    expect(await loader.load("k", "s", () => Promise.reject(new Error("boom")), 50)).toBeNull();
  });

  it("drops only review targets a reviewed claim already covers with the same bytes", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const claim = createLearningClaim({
      workspaceId: "ws",
      nodePath: "/src",
      topic: "Store",
      category: "architecture",
      statement: "Store is isolated.",
      sources: [{ path: "src/a.ts", digest }],
    });
    const map = excludeVerifiedTargets(
      {
        status: "current",
        persisted: true,
        modules: [],
        sourceExamples: [],
        instruction: "",
        reviewTargets: [
          { path: "src/a.ts", reason: "changed", digest },
          { path: "src/a.ts", reason: "changed", digest: `sha256:${"b".repeat(64)}` },
          { path: "src/b.ts", reason: "added", digest },
        ],
      },
      [claim],
    );
    expect(map.reviewTargets?.map((t) => `${t.path}:${t.digest?.slice(7, 8)}`)).toEqual([
      "src/a.ts:b",
      "src/b.ts:a",
    ]);
  });
});
