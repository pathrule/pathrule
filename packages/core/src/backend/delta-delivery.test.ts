// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleHookIndex, assembleWarehouse, type HookIndexInput } from "./hook-index.js";
import { applyDelta, computeDelta, type InjectedRecord, type SelectedItem } from "./delta-gate.js";
import { buildDeltaInjection } from "./delta-delivery.js";

function input(): HookIndexInput {
  return {
    workspaceId: "ws",
    generatedAt: "2026-06-10T00:00:00.000Z",
    memories: [
      { id: "m1", title: "Encapsulation model", content: "Plugins create a new context. ".repeat(20), node_path: "/lib" },
      { id: "m2", title: "Error handling", content: "Throw with statusCode + stable code. ".repeat(20), node_path: "/lib" },
      { id: "m3", title: "Schema-first validation", content: "Validate with ajv at registration. ".repeat(20), node_path: "/lib" },
    ],
    rules: [],
    skills: [],
    recentActivitySubjects: [],
    recentActivityDigest: [],
    workEpisodes: [],
    pendingRefreshCount: 0,
    inProgressRefreshCount: 0,
  };
}

// Build SelectedItem[] from the matching index so warehouse/index hashes are exercised together.
function selectedFrom(inp: HookIndexInput): SelectedItem[] {
  const idx = assembleHookIndex(inp);
  const stubs = idx.path_memories["/lib"] ?? [];
  return stubs.map((s) => ({
    id: s.id,
    type: "memory" as const,
    content_hash: s.content_hash!,
    relevance_signature: "path:/lib",
  }));
}

describe("delta delivery (engine-level efficiency)", () => {
  it("warehouse and index agree on content_hash (delta correctness invariant)", () => {
    const inp = input();
    const idx = assembleHookIndex(inp);
    const wh = assembleWarehouse(inp);
    for (const s of idx.path_memories["/lib"] ?? []) {
      expect(wh[s.id]!.content_hash).toBe(s.content_hash);
    }
  });

  it("SIMULATION: across 5 unchanged turns, only turn 1 spends tokens (footprint flat)", () => {
    const inp = input();
    const warehouse = assembleWarehouse(inp);
    const selected = selectedFrom(inp);

    let ledger: InjectedRecord[] = [];
    const perTurnTokens: number[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const delta = computeDelta(selected, ledger);
      const delivery = buildDeltaInjection({ emit: delta.emit, warehouse });
      perTurnTokens.push(delivery.tokens);
      ledger = applyDelta(ledger, delta.emit);
    }

    expect(perTurnTokens[0]).toBeGreaterThan(0); // turn 1: full bodies injected
    expect(perTurnTokens.slice(1)).toEqual([0, 0, 0, 0]); // turns 2-5: silence

    const deltaTotal = perTurnTokens.reduce((a, b) => a + b, 0);
    const alwaysInjectTotal = perTurnTokens[0]! * 5; // baseline: re-inject everything every turn
    expect(deltaTotal).toBe(perTurnTokens[0]); // delta mode pays once
    expect(deltaTotal).toBeLessThan(alwaysInjectTotal / 4); // ~5x fewer over 5 turns
  });

  it("delivers full bodies on turn 1 (not previews) and is stably ordered", () => {
    const inp = input();
    const warehouse = assembleWarehouse(inp);
    const delivery = buildDeltaInjection({
      emit: computeDelta(selectedFrom(inp), []).emit,
      warehouse,
    });
    // full body present (not the 120-char preview)
    expect(delivery.text).toContain(warehouse["m1"]!.body);
    // stable order by id: m1 block before m2 before m3
    expect(delivery.text.indexOf("## memory: Encapsulation model")).toBeLessThan(
      delivery.text.indexOf("## memory: Error handling"),
    );
    expect(delivery.injectedIds).toEqual(["m1", "m2", "m3"]);
  });

  it("re-injects only the edited item on a later turn", () => {
    const inp = input();
    let ledger = applyDelta([], computeDelta(selectedFrom(inp), []).emit);

    // edit m2's body → new warehouse + new hash
    const edited = input();
    edited.memories[1]!.content = "COMPLETELY NEW error policy. ".repeat(20);
    const wh2 = assembleWarehouse(edited);
    const sel2 = selectedFrom(edited);

    const delta = computeDelta(sel2, ledger);
    expect(delta.emit.map((e) => e.id)).toEqual(["m2"]); // only the edited one
    const delivery = buildDeltaInjection({ emit: delta.emit, warehouse: wh2 });
    expect(delivery.text).toContain(wh2["m2"]!.body);
    expect(delivery.injectedIds).toEqual(["m2"]);
  });

  it("budgets a burst: first block always delivered, overflow deferred not dropped", () => {
    const big = (id: string) => ({ id, type: "memory" as const, content_hash: id, relevance_signature: "r" });
    const warehouse = {
      a: { type: "memory" as const, title: "A", body: "x".repeat(8000), content_hash: "a" },
      b: { type: "memory" as const, title: "B", body: "y".repeat(8000), content_hash: "b" },
    };
    const delivery = buildDeltaInjection({
      emit: [
        { ...big("a"), reason: "new" as const },
        { ...big("b"), reason: "new" as const },
      ],
      warehouse,
      budgetTokens: 1000,
    });
    expect(delivery.injectedIds).toEqual(["a"]); // first always fits
    expect(delivery.deferredIds).toEqual(["b"]); // overflow deferred, not lost
  });
});
