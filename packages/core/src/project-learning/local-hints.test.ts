// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { existingLearningHints } from "./local-hints.js";

describe("existing local output reuse", () => {
  it("has a zero-data fallback and fails closed on a missing local store", async () => {
    expect(await existingLearningHints({}, "ws", "/")).toEqual([]);
    expect(
      await existingLearningHints(
        {
          contextsForHookIndex() {
            throw new Error("unavailable");
          },
        },
        "ws",
        "/",
      ),
    ).toEqual([]);
  });
  it("keeps hints bounded and scoped without accepting ungrounded facts", async () => {
    const contextsForHookIndex = () =>
      Array.from({ length: 50 }, (_, i) => ({
        type: "context" as const,
        authority: "context" as const,
        ref: `${i}`,
        scope: "/src",
        fact: "A source-backed fact. ".repeat(12),
        fact_grounded: i !== 0,
      }));
    expect(await existingLearningHints({ contextsForHookIndex }, "ws", "/other")).toEqual([]);
    const hints = await existingLearningHints({ contextsForHookIndex }, "ws", "/src/child");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((hint) => hint.ref === "0")).toBe(false);
    expect(JSON.stringify(hints).length).toBeLessThanOrEqual(1600);
  });

  it("reads a store the host serves, which answers asynchronously, the same way", async () => {
    const rows = [
      {
        type: "context" as const,
        authority: "context" as const,
        ref: "a",
        scope: "/src",
        fact: "Grounded.",
        fact_grounded: true,
      },
    ];
    const local = await existingLearningHints({ contextsForHookIndex: () => rows }, "ws", "/src");
    const remote = await existingLearningHints(
      { contextsForHookIndex: async () => rows, rationalesForHookIndex: async () => [] },
      "ws",
      "/src",
    );
    expect(remote).toEqual(local);
    expect(remote).toHaveLength(1);
    await expect(
      existingLearningHints(
        { contextsForHookIndex: () => Promise.reject(new Error("host gone")) },
        "ws",
        "/",
      ),
    ).resolves.toEqual([]);
  });
});
