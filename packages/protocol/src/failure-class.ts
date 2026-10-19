// SPDX-License-Identifier: Apache-2.0
//
// The single transient-vs-terminal verdict for cloud calls.
//
// Getting this wrong costs once per call site: any error treated as terminal
// becomes a phantom logout, and any silence treated as a server answer becomes
// a false "your session expired". The rule this module encodes:
// TERMINAL means the server answered and said no. Everything else is transient,
// which means keep the current state and retry.
//
// Deliberately dependency-free so the renderer, the MCP server, and the main
// process can all share one verdict.

export type FailureClass = "timeout" | "offline" | "server" | "auth" | "client" | "unknown";

export function classifyStatus(status: number): FailureClass {
  if (status >= 500) return "server";
  if (status === 401 || status === 403) return "auth";
  if (status >= 400) return "client";
  return "unknown";
}

const OFFLINE_PATTERN =
  /failed to fetch|networkerror|network error|enotfound|econnrefused|econnreset|eai_again|dns|socket hang up|load failed/;

/**
 * The human-readable message of anything thrown, including the shapes that are NOT
 * Error instances.
 *
 * This matters more than it looks. Database clients throw errors as PLAIN
 * OBJECTS (a PostgREST error is `{message, details, hint, code}`), so `String(err)` yields "[object
 * Object]" and every pattern matched against it fails silently. A caller pattern-
 * matching on the message would then see nothing and fall through to its default,
 * which for a retry loop means "transient": a database that answered a definite NO
 * gets retried forever. Always read the message through here.
 */
export function errorMessage(err: unknown, fallback = ""): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return fallback;
}

/**
 * Map a Postgres SQLSTATE to a failure class.
 *
 * Only the classes where the answer is unambiguous are listed. An integrity or
 * permission violation is the database ANSWERING no, which no retry will change; a
 * connection or resource condition is the database being unavailable, which a retry
 * may well fix. Anything else stays unknown, and unknown stays transient.
 */
function classifySqlState(code: string): FailureClass | null {
  const cls = code.slice(0, 2);
  // 22 data exception, 23 integrity constraint, 42 syntax/access rule, P0 raise_exception.
  if (cls === "22" || cls === "23" || cls === "42" || cls === "P0") return "client";
  // 08 connection exception, 53 insufficient resources, 57 operator intervention,
  // 58 external system error, XX internal error.
  if (cls === "08" || cls === "53" || cls === "57" || cls === "58" || cls === "XX") {
    return "server";
  }
  return null;
}

/**
 * The server answered, but the relation, function, or column the request names does not
 * exist on it (yet).
 *
 * PostgREST reports these as its own `PGRST20x` "not in the schema cache" codes, which are
 * eight characters and so never pass the SQLSTATE shape test: before this they read as
 * `unknown`, which is transient, and a queue that stops a pass on a transient failure let
 * one write aimed at a table this deployment does not have block every write behind it.
 * The SQLSTATE forms (42P01 undefined_table, 42883 undefined_function, 42703
 * undefined_column) arrive when the same gap is hit from inside a function.
 *
 * Neither "retry now" nor "give up" is right for this. The usual cause is a client that
 * shipped ahead of its migration (or an older server behind a newer app), and it resolves
 * itself when the other side catches up, so the queue parks the write rather than
 * retrying it in a loop or holding it as a refusal. classifyError deliberately leaves the
 * PGRST forms `unknown`: a READ that hits one should keep falling back to the local
 * mirror, which is the more useful answer there. Only callers that stop on transient
 * failures need to ask this first.
 */
const MISSING_SCHEMA_CODES = new Set([
  "PGRST202",
  "PGRST204",
  "PGRST205",
  "42P01",
  "42883",
  "42703",
]);

export function isMissingSchemaFailure(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && MISSING_SCHEMA_CODES.has(code);
}

export function classifyError(err: unknown): FailureClass {
  if (err === null || err === undefined) return "unknown";

  const name = (err as { name?: string }).name ?? "";
  if (name === "RequestTimeoutError" || name === "AbortError" || name === "TimeoutError") {
    return "timeout";
  }

  // HTTP clients surface failures as objects carrying a status.
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status > 0) return classifyStatus(status);

  // PostgrestError carries no status, only a SQLSTATE. Without this, a trigger that
  // raised a check_violation reads as "unknown" and is retried until the end of time.
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    const fromSqlState = classifySqlState(code);
    if (fromSqlState) return fromSqlState;
  }

  const message = errorMessage(err).toLowerCase();
  if (/timeout|timed out|deadline/.test(message)) return "timeout";
  if (OFFLINE_PATTERN.test(message)) return "offline";
  return "unknown";
}

/**
 * Transient failures keep state and retry. `unknown` is deliberately transient:
 * an unrecognised failure must never be the reason a user loses their session or
 * their data.
 */
export function isTransient(cls: FailureClass): boolean {
  return cls !== "auth" && cls !== "client";
}

export function isTransientFailure(err: unknown): boolean {
  return isTransient(classifyError(err));
}

/**
 * Result shape for list fetches that must not collapse a failure into an empty
 * list. Returning `[]` on error is indistinguishable from "this user has none",
 * which is how a cloud hiccup emptied the workspace sidebar.
 */
export type FetchListResult<T> =
  | { ok: true; data: T[] }
  | { ok: false; transient: boolean; message: string };

export function failedList(err: unknown, fallbackMessage = "cloud request failed"): {
  ok: false;
  transient: boolean;
  message: string;
} {
  const cls = classifyError(err);
  return { ok: false, transient: isTransient(cls), message: errorMessage(err, fallbackMessage) };
}
