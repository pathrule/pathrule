// SPDX-License-Identifier: Apache-2.0
// Safe display names are a platform guarantee (the security matrix's
// url_like_display_name_rejected row): core owns the rule, so its test lives here.

import { describe, expect, it } from "vitest";

import {
  escapeTerminalControlChars,
  normalizeSafeDisplayName,
  safeDisplayNameOrNull,
  safeHttpUrlOrNull,
  validateSafeDisplayName,
} from "./safe-name.js";

describe("validateSafeDisplayName", () => {
  it("normalizes harmless whitespace", () => {
    expect(normalizeSafeDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(validateSafeDisplayName("  Ada   Lovelace  ", "profile")).toEqual({
      ok: true,
      value: "Ada Lovelace",
    });
  });

  it("rejects empty and too-long names", () => {
    expect(validateSafeDisplayName("   ", "workspace")).toEqual({ ok: false, reason: "empty" });
    expect(validateSafeDisplayName("a".repeat(81), "profile")).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("rejects URL-like names and dangerous schemes", () => {
    expect(validateSafeDisplayName("https://example.com", "workspace")).toEqual({
      ok: false,
      reason: "url_like",
    });
    expect(validateSafeDisplayName("javascript:alert(1)", "organization")).toEqual({
      ok: false,
      reason: "url_like",
    });
    expect(validateSafeDisplayName("example.com", "profile")).toEqual({
      ok: false,
      reason: "url_like",
    });
  });

  it("allows domain-like organization names without schemes", () => {
    expect(validateSafeDisplayName("example.com", "organization")).toEqual({
      ok: true,
      value: "example.com",
    });
  });

  it("rejects control characters and html-like content", () => {
    expect(validateSafeDisplayName("Hello\nWorld", "workspace")).toEqual({
      ok: false,
      reason: "control_chars",
    });
    expect(validateSafeDisplayName("<script>alert(1)</script>", "profile")).toEqual({
      ok: false,
      reason: "html_like",
    });
  });

  it("preserves international human names", () => {
    expect(validateSafeDisplayName("Şenay Çakır", "profile")).toEqual({
      ok: true,
      value: "Şenay Çakır",
    });
    expect(validateSafeDisplayName("山田太郎", "profile")).toEqual({
      ok: true,
      value: "山田太郎",
    });
    expect(validateSafeDisplayName("André Lévêque", "profile")).toEqual({
      ok: true,
      value: "André Lévêque",
    });
  });

  it("rejects platform-reserved names", () => {
    expect(validateSafeDisplayName("Pathrule Support", "organization")).toEqual({
      ok: false,
      reason: "reserved",
    });
    expect(validateSafeDisplayName("pathrule", "workspace")).toEqual({
      ok: true,
      value: "pathrule",
    });
    expect(validateSafeDisplayName("admin", "profile")).toEqual({
      ok: false,
      reason: "reserved",
    });
  });

  it("provides safe read helpers for metadata and terminal output", () => {
    expect(safeDisplayNameOrNull("  Ada   Lovelace  ", "profile")).toBe("Ada Lovelace");
    expect(safeDisplayNameOrNull("https://example.com", "profile")).toBeNull();
    expect(safeHttpUrlOrNull("https://cdn.example.test/avatar.png")).toBe(
      "https://cdn.example.test/avatar.png",
    );
    expect(safeHttpUrlOrNull("javascript:alert(1)")).toBeNull();
    expect(escapeTerminalControlChars("Ada\u001b[2J\nLovelace")).toBe("Ada\\u001b[2J\\nLovelace");
  });
});
