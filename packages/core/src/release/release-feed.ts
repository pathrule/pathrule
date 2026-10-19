// SPDX-License-Identifier: Apache-2.0
/**
 * Reading the release manifest: one GET of a static, signed file, with a deadline and a size cap,
 * verified before anything in it is believed, and remembered in the update state so every other
 * surface can answer from disk without the network.
 *
 * Quiet by construction: an offline machine, a slow network, a server error or a refused manifest
 * is a result, never an exception, and the caller decides whether anyone hears about it (no one
 * does on the passive paths). The request carries no account, no install id and no cookie; the
 * user agent names the product and its version, the way a package manager's does.
 */
import {
  RELEASE_MANIFEST_MAX_BYTES,
  RELEASE_MANIFEST_URL,
  type ReleaseManifest,
} from "@pathrule/protocol/release-manifest.js";

import { createTimeoutFetch } from "../net/timeout-fetch.js";
import {
  verifyReleaseEnvelope,
  type ReleaseSigningKey,
  type ReleaseVerificationFailure,
} from "./manifest-signature.js";
import { readUpdateState, updateUpdateState, type UpdateState } from "./update-state.js";

/** A successful check is not repeated within a day. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed one (offline, a server error) is retried after an hour, not on every command. */
export const UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const RELEASE_FEED_TIMEOUT_MS = 5_000;

export type ReleaseFeedFailure =
  | "offline"
  | "http_error"
  | "too_large"
  | "not_json"
  | "bad_url"
  | ReleaseVerificationFailure;

export interface VerifiedManifest {
  manifest: ReleaseManifest;
  /** When it was fetched and verified. */
  checkedAt: string;
}

export type ReleaseFeedResult =
  | ({ ok: true; source: "network" | "cache" } & VerifiedManifest)
  | { ok: false; reason: ReleaseFeedFailure; detail: string; cached: VerifiedManifest | null };

export interface ReleaseFeedOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** `pathrule-cli/1.0.0`, `pathrule-vscode/0.8.0`. */
  userAgent: string;
  keys?: readonly ReleaseSigningKey[];
  timeoutMs?: number;
}

/**
 * The manifest URL: `PATHRULE_RELEASE_MANIFEST_URL`, else the official one. Only https, or http to
 * this machine for a local test server; anything else falls back to the official URL.
 */
export function releaseManifestUrl(env: NodeJS.ProcessEnv): string {
  const override = env.PATHRULE_RELEASE_MANIFEST_URL?.trim();
  if (!override) return RELEASE_MANIFEST_URL;
  try {
    const url = new URL(override);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
  } catch {
    // Not a URL.
  }
  return RELEASE_MANIFEST_URL;
}

/** Whether a check is due: none succeeded within a day and none failed within the hour. */
export function updateCheckDue(state: UpdateState, now: Date = new Date()): boolean {
  const age = (iso: string | undefined) =>
    iso ? now.getTime() - Date.parse(iso) : Number.POSITIVE_INFINITY;
  const sinceCheck = age(state.last_check_at);
  const sinceAttempt = age(state.last_attempt_at);
  // A timestamp in the future (a clock moved back) counts as stale, not as fresh forever.
  const fresh = (ms: number, window: number) => Number.isFinite(ms) && ms >= 0 && ms < window;
  if (fresh(sinceCheck, UPDATE_CHECK_INTERVAL_MS)) return false;
  if (fresh(sinceAttempt, UPDATE_RETRY_INTERVAL_MS) && state.last_error) return false;
  return true;
}

/** The last verified manifest on disk, verified again now; null when none or no longer valid. */
export function cachedReleaseManifest(
  env: NodeJS.ProcessEnv,
  options: { now?: Date; keys?: readonly ReleaseSigningKey[] } = {},
): VerifiedManifest | null {
  const state = readUpdateState(env);
  if (state.envelope === undefined || !state.last_check_at) return null;
  const verified = verifyReleaseEnvelope(state.envelope, {
    keys: options.keys,
    now: options.now,
    minSequence: state.highest_sequence,
  });
  return verified.ok ? { manifest: verified.manifest, checkedAt: state.last_check_at } : null;
}

async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > max ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch, verify and remember the manifest. On any failure the previous verified manifest (if still
 * valid) comes back as `cached`, and the failure is recorded so the next check waits an hour.
 */
export async function fetchReleaseManifest(
  options: ReleaseFeedOptions,
): Promise<ReleaseFeedResult> {
  const now = options.now ?? (() => new Date());
  const env = options.env;
  const url = releaseManifestUrl(env);
  const state = readUpdateState(env);
  const cached = () => cachedReleaseManifest(env, { now: now(), keys: options.keys });
  const fail = (reason: ReleaseFeedFailure, detail: string): ReleaseFeedResult => {
    updateUpdateState(env, (s) => ({
      ...s,
      last_attempt_at: now().toISOString(),
      last_error: reason,
    }));
    return { ok: false, reason, detail, cached: cached() };
  };

  const timed = createTimeoutFetch(options.fetchImpl ?? fetch, {
    budgets: { readMs: options.timeoutMs ?? RELEASE_FEED_TIMEOUT_MS },
  });
  let body: string | null;
  try {
    const response = await timed(url, {
      headers: { accept: "application/json", "user-agent": options.userAgent },
      credentials: "omit",
      redirect: "follow",
    });
    if (!response.ok) return fail("http_error", `HTTP ${response.status}`);
    body = await readCapped(response, RELEASE_MANIFEST_MAX_BYTES);
  } catch (error) {
    return fail("offline", error instanceof Error ? error.name : "network error");
  }
  if (body === null) return fail("too_large", `larger than ${RELEASE_MANIFEST_MAX_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fail("not_json", "the manifest is not JSON");
  }
  const verified = verifyReleaseEnvelope(raw, {
    keys: options.keys,
    now: now(),
    minSequence: state.highest_sequence,
  });
  if (!verified.ok) return fail(verified.reason, verified.detail);

  const checkedAt = now().toISOString();
  updateUpdateState(env, (s) => {
    const next: UpdateState = {
      ...s,
      highest_sequence: Math.max(s.highest_sequence, verified.manifest.sequence),
      last_check_at: checkedAt,
      last_attempt_at: checkedAt,
      envelope: raw,
    };
    delete next.last_error;
    return next;
  });
  return { ok: true, source: "network", manifest: verified.manifest, checkedAt };
}
