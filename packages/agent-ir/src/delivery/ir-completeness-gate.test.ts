// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { irCompletenessGate } from "./ir-completeness-gate.js";

describe("irCompletenessGate", () => {
  it("ZERO: no atoms falls back to prose", () => {
    const r = irCompletenessGate({ atomCount: 0, deliveredText: "", sourceText: "anything" });
    expect(r).toEqual({ decision: "PROSE", level: "ZERO", reason: "zero_atoms" });
  });

  it("FULL: a self-contained REMEDY compiles to IR", () => {
    const src = "Any code that parses an API response body MUST return null for an empty body before calling JSON.parse.";
    const r = irCompletenessGate({ atomCount: 1, deliveredText: "[REMEDY] return null for an empty body before JSON.parse", sourceText: src });
    expect(r.decision).toBe("IR");
    expect(r.level).toBe("FULL");
  });

  it("PARTIAL: a PRECEDENCE that dropped the loser from the DELIVERY falls back", () => {
    const src = "For currency, use formatMoney from src/money.js. It takes precedence over Intl.NumberFormat. Do not use Intl.NumberFormat for money.";
    // delivery kept only the winner pointer, lost "Intl"
    const r = irCompletenessGate({ atomCount: 1, deliveredText: "[CONSTRAINT] src/money.js:formatMoney", sourceText: src });
    expect(r.decision).toBe("PROSE");
    expect(r.level).toBe("PARTIAL");
    expect(r.reason).toContain("relationship_loser_missing");
  });

  it("FULL: a PRECEDENCE whose delivery KEEPS the loser compiles to IR", () => {
    const src = "For currency, use formatMoney. It takes precedence over Intl.NumberFormat. Do not use Intl.NumberFormat.";
    const r = irCompletenessGate({ atomCount: 2, deliveredText: "[SELECTION] use formatMoney, not Intl -> money.js:formatMoney", sourceText: src });
    expect(r.decision).toBe("IR");
  });

  it("PARTIAL: a dense multi-fact CONTEXT whose delivery covers <half of the operational sentences falls back", () => {
    const src = "The db exported from src/db.js is a read-only replica. Persisting MUST go through the write queue via queue.push. Calling db.insert throws in production.";
    // delivery captured only one incidental fact, not the operative rules
    const r = irCompletenessGate({ atomCount: 1, deliveredText: "[CONTEXT] src/db.js exists", sourceText: src });
    expect(r.decision).toBe("PROSE");
    expect(r.level).toBe("PARTIAL");
  });

  it("PARTIAL: an ordered procedure delivered as a single unit falls back", () => {
    const src = "Cache setup: first, call connect(). Then, call warm(). Finally, call ready(). All three, in order, every time.";
    const r = irCompletenessGate({ atomCount: 1, deliveredText: "[PROCEDURE] set up the cache", sourceText: src });
    expect(r.decision).toBe("PROSE");
    expect(r.reason).toBe("procedure_steps_missing");
  });

  it("judges the DELIVERY, not the source: loser present in source but absent from delivery still falls back", () => {
    const src = "Parse ISO dates with parseIso. It takes precedence over legacyParse, which is deprecated.";
    const r = irCompletenessGate({ atomCount: 1, deliveredText: "[CONSTRAINT] src/dates.js:parseIso", sourceText: src });
    expect(r.decision).toBe("PROSE");
    expect(r.reason).toContain("legacyparse");
  });

  describe("named code (language-neutral)", () => {
    it("falls back when a named identifier is missing, whatever language the sentence is in", () => {
      const src = "Para tutarlarını biçimlendirirken Intl.NumberFormat değil formatMoney tercih edilir.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "the preferred choice is formatMoney", sourceText: src });
      expect(r.decision).toBe("PROSE");
      expect(r.reason).toBe("named_literal_missing:intl.numberformat");
    });

    it("accepts a dotted name carried by its head, like the relationship check does", () => {
      const src = "Use formatMoney for money; Intl.NumberFormat is not allowed there.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "the preferred choice is formatMoney over Intl", sourceText: src });
      expect(r.decision).toBe("IR");
    });

    it("requires inline code, calls, snake_case and file paths to survive", () => {
      const delivered = "re-register the template image on nativeTheme.updated";
      for (const [src, literal] of [
        ["Run `pnpm natives:node` first. Then re-register the template image on nativeTheme.updated.", "pnpm natives:node"],
        ["Call warmCache() and re-register the template image on nativeTheme.updated.", "warmcache"],
        ["Read tray_state and re-register the template image on nativeTheme.updated.", "tray_state"],
        ["See electron/tray.ts and re-register the template image on nativeTheme.updated.", "electron/tray.ts"],
      ] as const) {
        const r = irCompletenessGate({ atomCount: 2, deliveredText: delivered, sourceText: src });
        expect(r.reason, src).toBe(`named_literal_missing:${literal}`);
      }
    });

    it("does not treat abbreviations as names", () => {
      const src = "The tray icon renders blank, e.g. after a theme change; re-register the template image on nativeTheme.updated.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "When the tray icon renders blank, re-register the template image on nativeTheme.updated", sourceText: src });
      expect(r.decision).toBe("IR");
    });
  });

  describe("Turkish sources fail closed too", () => {
    it("catches a loser written BEFORE its marker", () => {
      const src = "Tarih işlemlerinde moment yerine dayjs kullan.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "the preferred choice is dayjs", sourceText: src });
      expect(r.decision).toBe("PROSE");
      expect(r.reason).toBe("relationship_loser_missing:moment");
    });

    it("keeps the IR when the delivery still names the loser", () => {
      const src = "Tarih işlemlerinde moment yerine dayjs kullan.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "the preferred choice is dayjs over moment", sourceText: src });
      expect(r.decision).toBe("IR");
    });

    it("drops the apostrophe suffix from the loser", () => {
      const src = "Sunucu tarafında axios'u kullanma, fetch yeterli.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "the preferred choice is fetch", sourceText: src });
      expect(r.reason).toBe("relationship_loser_missing:axios");
    });

    it("treats an ordered Turkish procedure as a sequence", () => {
      const src = "Önbelleği kurarken ilk olarak bağlantıyı aç, ardından ısıt, son olarak hazır işaretle.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "önbelleği kur", sourceText: src });
      expect(r).toMatchObject({ decision: "PROSE", reason: "procedure_steps_missing" });
    });

    it("counts Turkish operational sentences toward coverage", () => {
      const src = "Veritabanına doğrudan yazma işlemi asla yapılmamalı. Kalıcı yazmalar mutlaka kuyruk üzerinden geçmeli. Okuma kopyası yalnızca raporlama için kullanılır.";
      const r = irCompletenessGate({ atomCount: 1, deliveredText: "okuma kopyası raporlama için", sourceText: src });
      expect(r.decision).toBe("PROSE");
      expect(r.reason).toMatch(/^low_coverage:/);
    });
  });
});
