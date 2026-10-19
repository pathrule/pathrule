// SPDX-License-Identifier: Apache-2.0
//
// One fetch wrapper for every network client in the product.
//
// A client built on the platform fetch has NO timeout. A connection an
// edge holds open without ever answering (the Cloudflare 522 class) blocks the
// caller forever, and "hung" then looks exactly like "slow but working" to every
// layer above. That is how a cloud hiccup became a permanent splash screen: the
// root VersionGate awaits a policy read that can never settle.
//
// Budgets are per request CLASS, not per call, so an avatar upload is not judged
// by a read budget. Uploads (Blob / FormData / stream / ArrayBuffer bodies) get a
// much larger budget because they are legitimately slow.
//
// The caller's own AbortSignal is preserved: an outer abort still aborts, and it
// is NOT reported as a timeout (the distinction matters, because a timeout is a
// transient cloud verdict while a caller abort is a local decision).

export type RequestClass = "read" | "write" | "upload";

/** A deliberate fault in place of the real request (see `TimeoutFetchOptions.fault`). */
export type FaultFetch = (init: RequestInit) => Promise<Response>;

export interface TimeoutBudgets {
  readMs: number;
  writeMs: number;
  uploadMs: number;
}

export const DEFAULT_TIMEOUT_BUDGETS: TimeoutBudgets = {
  readMs: 8_000,
  writeMs: 15_000,
  uploadMs: 120_000,
};

function hasStreamingBody(init?: RequestInit): boolean {
  const body = init?.body;
  if (!body || typeof body === "string") return false;
  return (
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body as ArrayBufferView)
  );
}

export function classifyRequest(init?: RequestInit): RequestClass {
  if (hasStreamingBody(init)) return "upload";
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

export function budgetFor(cls: RequestClass, budgets: TimeoutBudgets): number {
  if (cls === "read") return budgets.readMs;
  if (cls === "write") return budgets.writeMs;
  return budgets.uploadMs;
}

export class RequestTimeoutError extends Error {
  readonly requestClass: RequestClass;
  readonly budgetMs: number;

  constructor(cls: RequestClass, budgetMs: number) {
    super(`pathrule: ${cls} request exceeded its ${budgetMs}ms budget`);
    this.name = "RequestTimeoutError";
    this.requestClass = cls;
    this.budgetMs = budgetMs;
  }
}

/**
 * Combine our budget signal with the caller's, so an outer abort is still
 * honoured. `AbortSignal.any` exists in Chromium 116+ and Node 20.3+; the manual
 * fallback keeps this file safe in older test environments.
 */
function combineSignals(ours: AbortSignal, theirs: AbortSignal | null | undefined): AbortSignal {
  if (!theirs) return ours;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([ours, theirs]);
  const controller = new AbortController();
  if (ours.aborted || theirs.aborted) {
    controller.abort();
    return controller.signal;
  }
  const forward = () => controller.abort();
  ours.addEventListener("abort", forward, { once: true });
  theirs.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

export interface TimeoutFetchOptions {
  budgets?: Partial<TimeoutBudgets>;
  /** Test seam. Defaults to the global timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Inject a deliberate fault instead of making the request. Resolved by the CALLER
   * from its own dev-only source (never read from an env var in here), so a packaged
   * build cannot pick a fault up by accident. The deadline still applies, which is
   * exactly what makes a hanging fault a useful test.
   */
  fault?: FaultFetch | null;
}

/**
 * Wrap a fetch implementation so every request carries a deadline. Pass the
 * result as the fetch a network client uses.
 */
export function createTimeoutFetch(
  base: typeof fetch,
  options: TimeoutFetchOptions = {},
): typeof fetch {
  const budgets: TimeoutBudgets = { ...DEFAULT_TIMEOUT_BUDGETS, ...options.budgets };
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  const timeoutFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const requestInit = init as RequestInit | undefined;
    const cls = classifyRequest(requestInit);
    const budgetMs = budgetFor(cls, budgets);
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), budgetMs);
    try {
      const signal = combineSignals(controller.signal, requestInit?.signal);
      if (options.fault) {
        return await options.fault({ ...requestInit, signal });
      }
      return await base(input, { ...requestInit, signal });
    } catch (err) {
      // Our deadline fired and the caller did not abort: report it as a timeout
      // so the failure classifier can call it transient.
      if (controller.signal.aborted && !requestInit?.signal?.aborted) {
        throw new RequestTimeoutError(cls, budgetMs);
      }
      throw err;
    } finally {
      clearTimer(timer);
    }
  };

  return timeoutFetch as typeof fetch;
}
