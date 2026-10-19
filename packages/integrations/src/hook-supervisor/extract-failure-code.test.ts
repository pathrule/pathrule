// SPDX-License-Identifier: Apache-2.0
// Tests for extractFailureCode.
//
// Covers:
//   - All fixture scenarios from the original failure corpus.
//   - Success always returns null.
//   - Ambiguous controls always return 'unknown' (never specific codes).
//   - Deterministic ordering: first regex match in the bank wins.
//   - Signal-based timeout fallback.
//   - exit_nonzero residual.

import { describe, it, expect } from "vitest";
import { extractFailureCode } from "./extract-failure-code.js";

describe("extractFailureCode", () => {
  // ── Success short-circuit ────────────────────────────────────────────────

  it("returns null when success=true regardless of stderr", () => {
    expect(
      extractFailureCode({
        success: true,
        exit_code: 0,
        stderr: "command timed out after 30s",
        signal: null,
        duration_ms: null,
      }),
    ).toBeNull();
  });

  it("returns null when success=true with empty stderr", () => {
    expect(
      extractFailureCode({
        success: true,
        exit_code: 0,
        stderr: "",
        signal: null,
        duration_ms: null,
      }),
    ).toBeNull();
  });

  // ── Fixture: Claude bash-timeout ─────────────────────────────────────────

  it('classifies "command timed out after 30s" as timeout', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "command timed out after 30s",
        signal: null,
        duration_ms: 30002,
      }),
    ).toBe("timeout");
  });

  it('classifies "timed out" as timeout', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "the operation timed out",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("timeout");
  });

  it("classifies ECONNABORTED as timeout", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "connect ECONNABORTED 127.0.0.1:5432",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("timeout");
  });

  // ── Fixture: Claude edit-enoent ──────────────────────────────────────────

  it("classifies ENOENT as file_not_found", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "ENOENT: no such file or directory, open '/tmp/nonexistent-file.ts'",
        signal: null,
        duration_ms: 5,
      }),
    ).toBe("file_not_found");
  });

  it('classifies "No such file or directory" as file_not_found', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "ls: cannot access /foo: No such file or directory",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("file_not_found");
  });

  // ── Fixture: Windsurf write-perm ─────────────────────────────────────────

  it("classifies EACCES as permission_denied", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "EACCES: permission denied, open '/etc/protected-file.conf'",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("permission_denied");
  });

  it('classifies "permission denied" (lowercase) as permission_denied', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "chmod: permission denied",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("permission_denied");
  });

  // ── Rate limit ───────────────────────────────────────────────────────────

  it("classifies HTTP 429 as rate_limit", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "Request failed with status 429 Too Many Requests",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("rate_limit");
  });

  it('classifies "rate-limited" as rate_limit', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "you have been rate-limited",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("rate_limit");
  });

  // ── Token limit ──────────────────────────────────────────────────────────

  it("classifies context_length_exceeded as token_limit", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "error: context_length_exceeded",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("token_limit");
  });

  it('classifies "maximum context length" as token_limit', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "maximum context length is 200000 tokens",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("token_limit");
  });

  // ── Fixture: Codex patch-syntax ──────────────────────────────────────────

  it("classifies SyntaxError as syntax_error", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "SyntaxError: unexpected token '}' at line 42",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("syntax_error");
  });

  it('classifies "parse error" as syntax_error', () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "JSON parse error at position 42",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("syntax_error");
  });

  // ── Signal-based timeout fallback ────────────────────────────────────────

  it("classifies SIGTERM + long duration as timeout when above threshold", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "",
        signal: "SIGTERM",
        duration_ms: 120_001,
        timeout_threshold_ms: 120_000,
      }),
    ).toBe("timeout");
  });

  it("does NOT classify SIGTERM as timeout when below threshold", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "",
        signal: "SIGTERM",
        duration_ms: 1000,
        timeout_threshold_ms: 120_000,
      }),
    ).toBe("unknown");
  });

  it("classifies SIGKILL + long duration as timeout", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "",
        signal: "SIGKILL",
        duration_ms: 200_000,
        timeout_threshold_ms: 120_000,
      }),
    ).toBe("timeout");
  });

  // ── exit_nonzero residual ────────────────────────────────────────────────

  it("classifies non-zero exit code with empty stderr as exit_nonzero (fixture m46-ambiguous-nonzero-exit-no-stderr)", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 1,
        stderr: "",
        signal: null,
        duration_ms: 3,
      }),
    ).toBe("exit_nonzero");
  });

  it("classifies non-zero exit code 127 (command not found) as exit_nonzero when no regex matches", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: 127,
        stderr: "",
        signal: null,
        duration_ms: null,
      }),
    ).toBe("exit_nonzero");
  });

  // ── 'unknown' controls ───────────────────────────────────────────────────

  it("classifies empty stderr + null exit_code as unknown (fixture m46-ambiguous-empty-stderr)", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: "",
        signal: null,
        duration_ms: 10,
      }),
    ).toBe("unknown");
  });

  it("classifies null stderr + null exit_code as unknown (fixture m46-ambiguous-null-stderr)", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: null,
        signal: null,
        duration_ms: null,
      }),
    ).toBe("unknown");
  });

  it("classifies unicode garbage stderr + null exit_code as unknown (fixture m46-ambiguous-unicode-garbage)", () => {
    expect(
      extractFailureCode({
        success: false,
        exit_code: null,
        stderr: " �é ·ÿ",
        signal: null,
        duration_ms: 5,
      }),
    ).toBe("unknown");
  });

  // ── Ordering determinism: first regex match wins ─────────────────────────

  it("does NOT classify timeout stderr as file_not_found even if ENOENT was also present", () => {
    // timeout regex bank is evaluated before file_not_found
    const result = extractFailureCode({
      success: false,
      exit_code: 1,
      stderr: "command timed out after 30s: ENOENT error was logged",
      signal: null,
      duration_ms: 30000,
    });
    // timeout matches first in the bank ordering
    expect(result).toBe("timeout");
  });
});
