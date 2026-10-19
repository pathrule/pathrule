// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { RoutingResult, RoutingDecision } from "@pathrule/protocol/routing-types.js";
import { resolveInlineIds } from "../lib/inline-decision.js";

const uuid1 = "11111111-1111-1111-1111-111111111111";
const uuid2 = "22222222-2222-2222-2222-222222222222";

function routing(partial: Partial<RoutingDecision> = {}): RoutingResult {
  return {
    decision: {
      next: "answer_directly",
      reason: "test",
      confidence: "high",
      ...partial,
    },
  };
}

describe("resolveInlineIds", () => {
  it("returns router-emitted preload_memory ids when present", () => {
    const r = routing({ include: [`preload_memory:${uuid1}`] });
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [uuid1],
      source: "router",
    });
  });

  it("caps router-emitted ids at 1 even if router emits multiple", () => {
    const r = routing({
      include: [`preload_memory:${uuid1}`, `preload_memory:${uuid2}`],
    });
    const out = resolveInlineIds(r, "focused");
    expect(out.ids).toHaveLength(1);
    expect(out.source).toBe("router");
  });

  it("skips inline entirely in deep mode even when router emitted", () => {
    const r = routing({ include: [`preload_memory:${uuid1}`] });
    expect(resolveInlineIds(r, "deep")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("falls back to decision.memory_id when router didn't emit preload and next=read_memory+high", () => {
    const r = routing({
      next: "read_memory",
      confidence: "high",
      memory_id: uuid1,
    });
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [uuid1],
      source: "fallback",
    });
  });

  it("does NOT fall back when confidence is low", () => {
    const r = routing({
      next: "read_memory",
      confidence: "low",
      memory_id: uuid1,
    });
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("does NOT fall back when next is not read_memory", () => {
    const r = routing({
      next: "edit_known_path",
      confidence: "high",
      memory_id: uuid1,
    });
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("does NOT fall back in deep mode", () => {
    const r = routing({
      next: "read_memory",
      confidence: "high",
      memory_id: uuid1,
    });
    expect(resolveInlineIds(r, "deep")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("router signal takes priority over fallback signal (mutual exclusion)", () => {
    const r = routing({
      next: "read_memory",
      confidence: "high",
      memory_id: uuid2,
      include: [`preload_memory:${uuid1}`],
    });
    const out = resolveInlineIds(r, "focused");
    expect(out.ids).toEqual([uuid1]);
    expect(out.source).toBe("router");
  });

  it("returns empty when routing has no decision", () => {
    const r: RoutingResult = { fallback: "no_user_intent" };
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("ignores malformed preload_memory entries (non-uuid)", () => {
    const r = routing({ include: [`preload_memory:${"not-a-uuid" as string}`] });
    expect(resolveInlineIds(r, "focused")).toEqual({
      ids: [],
      source: "none",
    });
  });

  it("dedupes same uuid appearing twice in router include", () => {
    const r = routing({
      include: [`preload_memory:${uuid1}`, `preload_memory:${uuid1}`],
    });
    const out = resolveInlineIds(r, "focused");
    expect(out.ids).toEqual([uuid1]);
  });

  it("works in minimal depth (not only focused)", () => {
    const r = routing({ include: [`preload_memory:${uuid1}`] });
    expect(resolveInlineIds(r, "minimal").source).toBe("router");
  });
});
