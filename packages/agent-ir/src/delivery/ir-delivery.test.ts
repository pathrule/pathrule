// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { decideDelivery, compileCacheKey, resolveCompileState } from "./ir-delivery.js";

const SRC = "Any code that parses an API response body MUST return null for an empty body before JSON.parse.";

describe("decideDelivery (fail-closed)", () => {
  it("PROSE when IR is not compiled yet (lazy compile pending)", () => {
    const d = decideDelivery({ compiledIrAvailable: false, sourceText: SRC });
    expect(d.mode).toBe("prose");
    expect(d.reason).toBe("ir_not_compiled_yet");
  });

  it("PROSE when compiled but zero atoms", () => {
    const d = decideDelivery({ compiledIrAvailable: true, deliveredText: "", atomCount: 0, sourceText: SRC });
    expect(d.mode).toBe("prose");
  });

  it("IR when compiled, non-empty, and the gate says FULL", () => {
    const d = decideDelivery({ compiledIrAvailable: true, deliveredText: "[REMEDY] return null for an empty body before JSON.parse", atomCount: 1, sourceText: SRC });
    expect(d.mode).toBe("ir");
    expect(d.gate?.decision).toBe("IR");
  });

  it("PROSE when compiled but the gate says PARTIAL (flattened PRECEDENCE loses the loser)", () => {
    const precSrc = "For currency use formatMoney. It takes precedence over Intl.NumberFormat. Do not use Intl.NumberFormat.";
    const d = decideDelivery({ compiledIrAvailable: true, deliveredText: "[CONSTRAINT] money.js:formatMoney", atomCount: 1, sourceText: precSrc });
    expect(d.mode).toBe("prose");
    expect(d.reason).toContain("gate:relationship_loser_missing");
  });
});

describe("lazy compile cache", () => {
  const hashHex = (s: string) => `h${s.length}`; // deterministic stub

  it("key is (source hash, compiler version)", () => {
    expect(compileCacheKey("abc", "c1", hashHex)).toBe("h3:c1");
  });

  it("reuse when the cached key matches", () => {
    const r = resolveCompileState({ sourceText: "abc", compilerVersion: "c1", hashHex, cachedKey: "h3:c1" });
    expect(r.state).toBe("reuse");
  });

  it("compile when source changed (hash differs)", () => {
    const r = resolveCompileState({ sourceText: "abcd", compilerVersion: "c1", hashHex, cachedKey: "h3:c1" });
    expect(r.state).toBe("compile");
  });

  it("compile when the compiler contract version changed (stale)", () => {
    const r = resolveCompileState({ sourceText: "abc", compilerVersion: "c2", hashHex, cachedKey: "h3:c1" });
    expect(r.state).toBe("compile");
  });

  it("compile when nothing is cached", () => {
    const r = resolveCompileState({ sourceText: "abc", compilerVersion: "c1", hashHex, cachedKey: null });
    expect(r.state).toBe("compile");
  });
});
