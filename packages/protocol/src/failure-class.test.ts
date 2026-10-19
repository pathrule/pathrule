// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  classifyError,
  classifyStatus,
  errorMessage,
  failedList,
  isMissingSchemaFailure,
  isTransient,
  isTransientFailure,
} from "./failure-class.js";

describe("classifyStatus", () => {
  it("calls 5xx a server failure", () => {
    expect(classifyStatus(500)).toBe("server");
    expect(classifyStatus(502)).toBe("server");
    // The Cloudflare 522 that started this work.
    expect(classifyStatus(522)).toBe("server");
  });

  it("calls 401/403 an auth failure and other 4xx a client failure", () => {
    expect(classifyStatus(401)).toBe("auth");
    expect(classifyStatus(403)).toBe("auth");
    expect(classifyStatus(400)).toBe("client");
    expect(classifyStatus(404)).toBe("client");
  });
});

describe("classifyError", () => {
  it("recognises an abort and a message-level timeout", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyError(abort)).toBe("timeout");
    expect(classifyError(new Error("Request timed out"))).toBe("timeout");
  });

  it("recognises network-level failures", () => {
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.pathrule.io"))).toBe("offline");
    expect(classifyError(new Error("socket hang up"))).toBe("offline");
  });

  it("prefers a carried status over the message", () => {
    expect(classifyError({ status: 503, message: "service unavailable" })).toBe("server");
    expect(classifyError({ status: 401, message: "invalid claim" })).toBe("auth");
  });

  it("treats an unrecognised failure as unknown, and unknown as transient", () => {
    expect(classifyError(new Error("something odd"))).toBe("unknown");
    expect(isTransient("unknown")).toBe(true);
  });
});

describe("isTransient", () => {
  it("keeps state for everything except an explicit server refusal", () => {
    expect(isTransient("timeout")).toBe(true);
    expect(isTransient("offline")).toBe(true);
    expect(isTransient("server")).toBe(true);
    expect(isTransient("auth")).toBe(false);
    expect(isTransient("client")).toBe(false);
  });

  it("classifies a 522 response object as transient", () => {
    expect(isTransientFailure({ status: 522 })).toBe(true);
  });
});

describe("failedList", () => {
  it("carries the transient verdict and a message instead of an empty list", () => {
    // Classified by name, so the protocol needs no fetch implementation to prove it.
    const timeout = Object.assign(new Error("pathrule: read request exceeded its 8000ms budget"), {
      name: "RequestTimeoutError",
    });
    const result = failedList(timeout);
    expect(result.ok).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.message).toContain("budget");
  });

  it("marks an auth failure terminal", () => {
    expect(failedList({ status: 401, message: "JWT expired" }).transient).toBe(false);
  });
});

// A PostgrestError is a PLAIN OBJECT: {message, details, hint, code}. No `status`, and
// not an Error instance. Every helper here has to survive that shape, because it is the
// shape the database's own refusals arrive in.
const POSTGREST_CAPACITY = {
  message: "capacity_hard_ceiling: Acme is at 301/150 memories, more than the plan allows",
  details: null,
  hint: null,
  code: "23514",
};

describe("errorMessage", () => {
  it("reads the message off a plain object, where String() gives [object Object]", () => {
    expect(String(POSTGREST_CAPACITY)).toBe("[object Object]");
    expect(errorMessage(POSTGREST_CAPACITY)).toContain("capacity_hard_ceiling");
  });

  it("reads an Error and a bare string", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
  });

  it("falls back when there is no message to read", () => {
    expect(errorMessage(null, "cloud request failed")).toBe("cloud request failed");
    expect(errorMessage({ code: "23514" }, "fallback")).toBe("fallback");
    // An empty message is not a message; it would render as a blank error to the user.
    expect(errorMessage({ message: "" }, "fallback")).toBe("fallback");
  });
});

describe("classifyError on a PostgrestError", () => {
  it("calls a constraint violation terminal instead of retrying it forever", () => {
    // Without the SQLSTATE mapping this object has no status and an unreadable message,
    // so it classified as "unknown" -> transient, and the queue retried a refusal the
    // database will never change its mind about.
    expect(classifyError(POSTGREST_CAPACITY)).toBe("client");
    expect(isTransientFailure(POSTGREST_CAPACITY)).toBe(false);
  });

  it("calls a raise_exception terminal", () => {
    expect(classifyError({ message: "capacity_grace_expired: ...", code: "P0001" })).toBe("client");
  });

  it("keeps a connection or resource condition transient", () => {
    expect(isTransientFailure({ message: "connection failure", code: "08006" })).toBe(true);
    expect(isTransientFailure({ message: "too many connections", code: "53300" })).toBe(true);
    expect(isTransientFailure({ message: "canceling statement", code: "57014" })).toBe(true);
  });

  it("leaves an unrecognised SQLSTATE class transient", () => {
    // Unknown must stay transient: an unrecognised failure is never a reason to give up
    // on a user's write.
    expect(isTransientFailure({ message: "who knows", code: "40001" })).toBe(true);
  });

  it("leaves a system error code that merely LOOKS like a SQLSTATE transient", () => {
    // "EPIPE" is five uppercase characters, so it passes the shape test. Its class "EP"
    // is in neither list, which is why the mapping is an allow-list of classes and not a
    // "recognised shape means the database answered" shortcut. A broken pipe is the
    // network failing mid-write, the most transient failure there is.
    expect(isTransientFailure({ message: "write EPIPE", code: "EPIPE" })).toBe(true);
  });

  it("does not mistake a non-SQLSTATE code for one", () => {
    // GoTrue and our own errors use word codes. Only a 5-char alphanumeric is a SQLSTATE.
    expect(classifyError({ message: "network error", code: "session_expired" })).toBe("offline");
    expect(classifyError({ message: "read timed out", code: "ETIMEDOUT" })).toBe("timeout");
  });

  it("recognises a PostgREST schema-cache miss without changing the read-path verdict", () => {
    // Eight characters, so not a SQLSTATE: it stays unknown (a read keeps falling back to
    // the mirror), and the queue asks isMissingSchemaFailure first so it parks the write
    // instead of stopping every pass on it.
    const missing = { code: "PGRST205", message: "Could not find the table in the schema cache" };
    expect(classifyError(missing)).toBe("unknown");
    expect(isMissingSchemaFailure(missing)).toBe(true);
    expect(isMissingSchemaFailure({ code: "42P01", message: "relation does not exist" })).toBe(
      true,
    );
    expect(isMissingSchemaFailure(POSTGREST_CAPACITY)).toBe(false);
  });

  it("still lets an explicit status win over the SQLSTATE", () => {
    // A 522 carrying a body Postgres never produced must stay transient.
    expect(isTransientFailure({ status: 522, code: "23514", message: "gateway" })).toBe(true);
  });
});
