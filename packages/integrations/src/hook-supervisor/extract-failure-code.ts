// SPDX-License-Identifier: Apache-2.0
// Deterministic failure-code extractor.
//
// Reads the regex bank from the spec JSON, compiles each pattern once at
// module load, then classifies a PostToolUse error in < 1ms (pure regex, no IO).
//
// Ordering contract (from the friction-pipe-design spec):
//   1. If success === true  → return null (always short-circuits).
//   2. Evaluate regex bank top-to-bottom: timeout, file_not_found,
//      permission_denied, rate_limit, token_limit, syntax_error.
//   3. Signal-based fallback: SIGTERM/SIGKILL + duration >= threshold → timeout.
//   4. Residual: exit_code is defined non-zero → exit_nonzero.
//   5. Residual-residual: tool failed, nothing matched → unknown.
//
// "skip beats wrong": a failed tool with no signal is 'unknown', never null.

/** The fixed set of failure codes this classifier returns. */
export type FailureCode =
  | "exit_nonzero"
  | "timeout"
  | "file_not_found"
  | "permission_denied"
  | "rate_limit"
  | "token_limit"
  | "syntax_error"
  | "unknown";

// ── Regex bank (sourced from 2026-05-21-m46-failure-code-regex-bank.json) ────
// Inlined here as a JS object so this module has no dynamic require/import
// of a JSON file from outside the package boundary (avoids path issues in the
// standalone pathrule-hook.js build). Keep in sync with the spec JSON.
const RAW_REGEX_BANK: Record<Exclude<FailureCode, "exit_nonzero" | "unknown">, string[]> = {
  timeout: [
    "\\bECONNABORTED\\b",
    "\\boperation timed out\\b",
    "\\bcommand timed out after \\d+",
    "\\btimed out\\b",
    "\\bDeadlineExceeded\\b",
    "\\bERR_SOCKET_TIMEOUT\\b",
    "\\bconnection timed out\\b",
    "\\bsocket hang up\\b",
    "\\bread timeout\\b",
  ],
  file_not_found: [
    "\\bENOENT\\b",
    "\\bNo such file or directory\\b",
    "\\bcannot find the file specified\\b",
    "\\bThe system cannot find the file\\b",
    "\\bFile not found\\b",
    // Claude Code's own wording, measured from a PostToolUseFailure on a missing Read
    // target: "File does not exist. Note: your current working directory is …".
    // Without this the most common file-tool failure on the most common client fell
    // through to 'unknown'.
    "\\bFile does not exist\\b",
    "\\bno such file\\b",
    "\\bpath does not exist\\b",
    "\\bfailed to open file\\b",
    "\\bFileNotFoundError\\b",
  ],
  permission_denied: [
    "\\bEACCES\\b",
    "\\bpermission denied\\b",
    "\\bOperation not permitted\\b",
    "\\bEPERM\\b",
    "\\bAccess is denied\\b",
    "\\bInsufficient permissions\\b",
    "\\bforbidden\\b",
    "\\bUnauthorized\\b",
  ],
  rate_limit: [
    "\\b429\\b",
    "\\brate.?limit(ed|ing)?\\b",
    "\\bToo Many Requests\\b",
    "\\bquota exceeded\\b",
    "\\bthrottle\\b",
    "\\bRetry-After\\b",
    "\\brateLimit\\b",
  ],
  token_limit: [
    "\\bcontext.{0,10}length.{0,10}exceed",
    "\\btoken.{0,10}limit\\b",
    "\\bmax_tokens exceeded\\b",
    "\\bContext window\\b",
    "\\btoo long for model\\b",
    "\\binput too large\\b",
    "\\bmaximum context length\\b",
    "\\bcontext_length_exceeded\\b",
  ],
  syntax_error: [
    "\\bSyntaxError\\b",
    "\\bunexpected token\\b",
    "\\bparse error\\b",
    "\\bParseError\\b",
    "\\bInvalid JSON\\b",
    "\\bJSON\\.parse\\b",
    "\\bunexpected end of input\\b",
    "\\billegal character\\b",
    "\\bunterminated string\\b",
    "\\bExpected.{0,30}but found\\b",
  ],
};

// Compiled once at module load — no per-call regex construction.
const COMPILED: Array<[Exclude<FailureCode, "exit_nonzero" | "unknown">, RegExp[]]> =
  Object.entries(RAW_REGEX_BANK).map(([code, patterns]) => [
    code as Exclude<FailureCode, "exit_nonzero" | "unknown">,
    patterns.map((p) => new RegExp(p, "i")),
  ]);

// ── Public interface ──────────────────────────────────────────────────────────

export interface ExtractInput {
  /** If true, always returns null (success never has a failure code). */
  success: boolean;
  /** Process exit code, or null when not available (e.g. tool was killed). */
  exit_code: number | null;
  /** Raw stderr text from the tool. null treated as empty string. */
  stderr: string | null;
  /** POSIX signal that terminated the process, if any. */
  signal: string | null;
  /** How long the tool ran in milliseconds. null when client doesn't emit it. */
  duration_ms: number | null;
  /**
   * Threshold in ms above which a SIGTERM/SIGKILL is classified as 'timeout'.
   * When not provided, the signal-based timeout heuristic is disabled.
   */
  timeout_threshold_ms?: number;
}

/**
 * Extract a failure code from a PostToolUse event's error fields.
 *
 * Returns:
 *   - `null`            when success === true (always).
 *   - specific code     when a regex or signal heuristic matches.
 *   - `'exit_nonzero'`  when exit_code is a defined non-zero integer.
 *   - `'unknown'`       when success === false and nothing else matched.
 *
 * This is the only function that reads the regex bank. Adapters must NOT
 * duplicate or extend the matching logic — they call this function.
 *
 * Latency budget: < 1ms per call on a warm module (all regex compiled at load).
 */
export function extractFailureCode(input: ExtractInput): FailureCode | null {
  // Short-circuit: successful tools never carry a failure code.
  if (input.success) return null;

  const haystack = input.stderr ?? "";

  // Evaluate regex bank in declared order — first match wins.
  for (const [code, regexes] of COMPILED) {
    if (regexes.some((r) => r.test(haystack))) {
      return code;
    }
  }

  // Signal-based fallback: SIGTERM or SIGKILL + duration >= threshold → timeout.
  if (
    (input.signal === "SIGTERM" || input.signal === "SIGKILL") &&
    input.timeout_threshold_ms != null &&
    input.duration_ms != null &&
    input.duration_ms >= input.timeout_threshold_ms
  ) {
    return "timeout";
  }

  // Residual: exit code is a defined, non-zero integer → exit_nonzero.
  if (typeof input.exit_code === "number" && input.exit_code !== 0) {
    return "exit_nonzero";
  }

  // Residual-residual: tool failed but nothing helped → unknown.
  // "skip beats wrong" — never silently drop a failed-but-unmatched event.
  return "unknown";
}
