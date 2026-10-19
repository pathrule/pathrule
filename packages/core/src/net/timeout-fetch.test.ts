// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIMEOUT_BUDGETS,
  RequestTimeoutError,
  budgetFor,
  classifyRequest,
  createTimeoutFetch,
} from "./timeout-fetch.js";
import { classifyError, failedList, isTransient } from "@pathrule/protocol/failure-class.js";

function neverSettles(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;
}

describe("classifyRequest", () => {
  it("treats GET and HEAD as reads", () => {
    expect(classifyRequest(undefined)).toBe("read");
    expect(classifyRequest({ method: "get" })).toBe("read");
    expect(classifyRequest({ method: "HEAD" })).toBe("read");
  });

  it("treats other verbs as writes", () => {
    expect(classifyRequest({ method: "POST", body: "{}" })).toBe("write");
    expect(classifyRequest({ method: "PATCH", body: "{}" })).toBe("write");
    expect(classifyRequest({ method: "DELETE" })).toBe("write");
  });

  it("treats binary and multipart bodies as uploads", () => {
    expect(classifyRequest({ method: "POST", body: new ArrayBuffer(8) })).toBe("upload");
    expect(classifyRequest({ method: "POST", body: new Uint8Array([1, 2]) })).toBe("upload");
    if (typeof FormData !== "undefined") {
      expect(classifyRequest({ method: "POST", body: new FormData() })).toBe("upload");
    }
  });

  it("gives uploads a far larger budget than reads", () => {
    expect(budgetFor("upload", DEFAULT_TIMEOUT_BUDGETS)).toBeGreaterThan(
      budgetFor("write", DEFAULT_TIMEOUT_BUDGETS),
    );
    expect(budgetFor("write", DEFAULT_TIMEOUT_BUDGETS)).toBeGreaterThan(
      budgetFor("read", DEFAULT_TIMEOUT_BUDGETS),
    );
  });
});

describe("createTimeoutFetch", () => {
  it("rejects a hung read with RequestTimeoutError at the budget", async () => {
    vi.useFakeTimers();
    try {
      const wrapped = createTimeoutFetch(neverSettles(), { budgets: { readMs: 8_000 } });
      const pending = wrapped("https://example.test/rest/v1/memories");
      const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies its own timeout as transient", async () => {
    vi.useFakeTimers();
    try {
      const wrapped = createTimeoutFetch(neverSettles(), { budgets: { readMs: 1_000 } });
      const pending = wrapped("https://example.test/rest/v1/memories").catch((err) => err);
      await vi.advanceTimersByTimeAsync(1_000);
      const err = await pending;
      expect(isTransient(classifyError(err))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a fast response through untouched", async () => {
    const response = new Response("ok", { status: 200 });
    const base = vi.fn(async () => response) as unknown as typeof fetch;
    const wrapped = createTimeoutFetch(base);
    await expect(wrapped("https://example.test/health")).resolves.toBe(response);
  });

  it("clears its timer so a settled call cannot abort later", async () => {
    const clearTimer = vi.fn();
    const base = (async () => new Response("ok")) as unknown as typeof fetch;
    const wrapped = createTimeoutFetch(base, { clearTimer });
    await wrapped("https://example.test/health");
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("honours a caller abort and does not report it as a timeout", async () => {
    const controller = new AbortController();
    const wrapped = createTimeoutFetch(neverSettles(), { budgets: { readMs: 60_000 } });
    const pending = wrapped("https://example.test/slow", { signal: controller.signal }).catch(
      (err) => err,
    );
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("uses the write budget for a mutation", async () => {
    const seen: number[] = [];
    const wrapped = createTimeoutFetch(neverSettles(), {
      budgets: { readMs: 1_000, writeMs: 5_000 },
      setTimer: (fn, ms) => {
        seen.push(ms);
        return setTimeout(fn, ms);
      },
    });
    void wrapped("https://example.test/rest/v1/memories", { method: "POST", body: "{}" }).catch(
      () => undefined,
    );
    expect(seen).toEqual([5_000]);
  });
});

describe("failure classification", () => {
  it("classifies its own timeout as a timeout", () => {
    expect(classifyError(new RequestTimeoutError("read", 8_000))).toBe("timeout");
  });

  it("turns its own timeout into a transient failed list with a message", () => {
    const result = failedList(new RequestTimeoutError("read", 8_000));
    expect(result.ok).toBe(false);
    expect(result.transient).toBe(true);
    expect(result.message).toContain("budget");
  });
});
