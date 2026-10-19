// SPDX-License-Identifier: Apache-2.0
// The launch and session tokens of `pathrule ui`: random, single use, expiring, compared as digests.
import { describe, expect, it } from "vitest";

import {
  bearerToken,
  LAUNCH_TOKEN_TTL_MS,
  mintToken,
  SESSION_TTL_MS,
  tokenDigest,
  tokenMatches,
  UiTokens,
} from "./tokens.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("ui tokens", () => {
  it("mints 32 random bytes in base64url", () => {
    const token = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(mintToken()).not.toBe(token);
  });

  it("compares digests, and refuses what is not a token", () => {
    const token = mintToken();
    expect(tokenMatches(token, tokenDigest(token))).toBe(true);
    expect(tokenMatches(`${token}x`, tokenDigest(token))).toBe(false);
    expect(tokenMatches(undefined, tokenDigest(token))).toBe(false);
    expect(tokenMatches("", tokenDigest(token))).toBe(false);
    expect(tokenMatches("a".repeat(10_000), tokenDigest("a".repeat(10_000)))).toBe(false);
  });

  it("reads a bearer header and nothing else", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBeUndefined();
    expect(bearerToken("Bearer a b")).toBeUndefined();
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it("trades a launch token once for a session that lasts its time", () => {
    const time = clock();
    const tokens = new UiTokens({ now: time.now });
    const launch = tokens.mintLaunch();
    const session = tokens.redeemLaunch(launch);
    expect(session).not.toBeNull();
    expect(session!.expiresAt).toBe(time.now() + SESSION_TTL_MS);
    expect(tokens.sessionValid(session!.sessionToken)).toBe(true);
    // Single use.
    expect(tokens.redeemLaunch(launch)).toBeNull();
    // A launch token is not a session, and a session is not a launch token.
    expect(tokens.sessionValid(launch)).toBe(false);
    expect(tokens.redeemLaunch(session!.sessionToken)).toBeNull();
    time.advance(SESSION_TTL_MS - 1);
    expect(tokens.sessionValid(session!.sessionToken)).toBe(true);
    time.advance(1);
    expect(tokens.sessionValid(session!.sessionToken)).toBe(false);
  });

  it("expires a launch token two minutes after it was minted, and spends it anyway", () => {
    const time = clock();
    const tokens = new UiTokens({ now: time.now });
    const late = tokens.mintLaunch();
    const onTime = tokens.mintLaunch();
    time.advance(LAUNCH_TOKEN_TTL_MS - 1);
    expect(tokens.redeemLaunch(onTime)).not.toBeNull();
    time.advance(1);
    expect(tokens.redeemLaunch(late)).toBeNull();
    expect(tokens.redeemLaunch(late)).toBeNull();
    expect(tokens.redeemLaunch(undefined)).toBeNull();
    expect(tokens.redeemLaunch("not-a-token")).toBeNull();
  });
});
