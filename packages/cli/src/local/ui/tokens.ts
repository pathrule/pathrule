// SPDX-License-Identifier: Apache-2.0
// The tokens of `pathrule ui`. A launch token is minted for each link the command prints or opens;
// it travels in the URL fragment (never sent to a server), works once, and expires after two
// minutes. The page trades it at `POST /api/session` for a session token, which it sends as a bearer
// on every API call until the session expires.
//
// Tokens are 32 random bytes in base64url. Only their SHA-256 digests are kept, and a presented
// token is compared digest to digest with `timingSafeEqual`, so neither its content nor its length
// shows in the time a comparison takes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const LAUNCH_TOKEN_TTL_MS = 120_000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Links nobody opened yet; the oldest goes first beyond this. */
const MAX_PENDING_LAUNCHES = 32;
/** Live sessions (tabs); the oldest goes first beyond this. */
const MAX_SESSIONS = 64;
/** A presented token longer than this is not one of ours, and is not hashed. */
const MAX_TOKEN_CHARS = 512;

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time: the presented token is hashed first, so both sides are 32 bytes. */
export function tokenMatches(presented: string | undefined, expected: Buffer): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  if (presented.length > MAX_TOKEN_CHARS) return false;
  return timingSafeEqual(tokenDigest(presented), expected);
}

/** The token of an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

interface Grant {
  digest: Buffer;
  expiresAt: number;
}

export interface UiSession {
  sessionToken: string;
  expiresAt: number;
}

export interface UiTokensOptions {
  /** The clock, in epoch milliseconds; tests move it. */
  now?: () => number;
  launchTtlMs?: number;
  sessionTtlMs?: number;
}

export class UiTokens {
  private launches: Grant[] = [];
  private sessions: Grant[] = [];
  private readonly now: () => number;
  private readonly launchTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(options: UiTokensOptions = {}) {
    this.now = options.now ?? Date.now;
    this.launchTtlMs = options.launchTtlMs ?? LAUNCH_TOKEN_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  /** A new single-use launch token. */
  mintLaunch(): string {
    this.prune();
    const token = mintToken();
    this.launches.push({ digest: tokenDigest(token), expiresAt: this.now() + this.launchTtlMs });
    if (this.launches.length > MAX_PENDING_LAUNCHES) this.launches.shift();
    return token;
  }

  /**
   * Trades a launch token for a session. The launch token is spent whether or not it was still
   * valid; null when it is unknown, spent or expired.
   */
  redeemLaunch(token: string | undefined): UiSession | null {
    const index = this.find(this.launches, token);
    if (index < 0) return null;
    const [grant] = this.launches.splice(index, 1);
    if (!grant || grant.expiresAt <= this.now()) return null;
    const sessionToken = mintToken();
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.push({ digest: tokenDigest(sessionToken), expiresAt });
    if (this.sessions.length > MAX_SESSIONS) this.sessions.shift();
    return { sessionToken, expiresAt };
  }

  /** Whether `token` is a live session. */
  sessionValid(token: string | undefined): boolean {
    this.prune();
    return this.find(this.sessions, token) >= 0;
  }

  /** Compares against every grant, so the time taken does not say which one matched. */
  private find(grants: readonly Grant[], token: string | undefined): number {
    let found = -1;
    grants.forEach((grant, index) => {
      if (tokenMatches(token, grant.digest) && found < 0) found = index;
    });
    return found;
  }

  private prune(): void {
    const now = this.now();
    this.launches = this.launches.filter((grant) => grant.expiresAt > now);
    this.sessions = this.sessions.filter((grant) => grant.expiresAt > now);
  }
}
