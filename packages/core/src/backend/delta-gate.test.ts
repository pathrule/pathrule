// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { applyDelta, computeDelta, type InjectedRecord, type SelectedItem } from "./delta-gate.js";

const item = (id: string, hash: string, sig = "sig"): SelectedItem => ({
  id,
  type: "memory",
  content_hash: hash,
  relevance_signature: sig,
});

describe("computeDelta (cache-stable delta gate)", () => {
  it("emits new items the first time they are selected", () => {
    const r = computeDelta([item("m1", "h1"), item("m2", "h2")], []);
    expect(r.emit.map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(r.emit.every((e) => e.reason === "new")).toBe(true);
    expect(r.unchanged).toEqual([]);
  });

  it("CACHE-STABILITY: re-selecting unchanged items emits NOTHING", () => {
    const selected = [item("m1", "h1"), item("m2", "h2")];
    const ledger = applyDelta([], computeDelta(selected, []).emit);
    const second = computeDelta(selected, ledger);
    expect(second.emit).toEqual([]); // silence ⇒ context unchanged ⇒ prompt cache holds
    expect(second.unchanged.sort()).toEqual(["m1", "m2"]);
  });

  it("re-emits an item whose content changed (edited)", () => {
    const ledger: InjectedRecord[] = [{ id: "m1", content_hash: "h1", relevance_signature: "sig" }];
    const r = computeDelta([item("m1", "h2")], ledger);
    expect(r.emit).toHaveLength(1);
    expect(r.emit[0]!.reason).toBe("content_changed");
  });

  it("re-emits an item whose relevance signature changed (newly relevant)", () => {
    const ledger: InjectedRecord[] = [{ id: "m1", content_hash: "h1", relevance_signature: "old" }];
    const r = computeDelta([item("m1", "h1", "new")], ledger);
    expect(r.emit).toHaveLength(1);
    expect(r.emit[0]!.reason).toBe("relevance_changed");
  });

  it("handles a mixed turn: new + changed + unchanged", () => {
    const ledger: InjectedRecord[] = [
      { id: "keep", content_hash: "h", relevance_signature: "sig" },
      { id: "edit", content_hash: "old", relevance_signature: "sig" },
    ];
    const r = computeDelta([item("keep", "h"), item("edit", "new"), item("fresh", "h")], ledger);
    expect(r.emit.map((e) => `${e.id}:${e.reason}`).sort()).toEqual([
      "edit:content_changed",
      "fresh:new",
    ]);
    expect(r.unchanged).toEqual(["keep"]);
  });

  it("applyDelta is immutable and folds emitted items into the ledger", () => {
    const ledger: InjectedRecord[] = [];
    const next = applyDelta(ledger, [item("m1", "h1")], { at: "2026-06-10T00:00:00Z", fileToolCount: 3 });
    expect(ledger).toEqual([]); // input not mutated
    expect(next).toEqual([
      { id: "m1", content_hash: "h1", relevance_signature: "sig", last_at: "2026-06-10T00:00:00Z", last_file_tool_count: 3 },
    ]);
  });
});
