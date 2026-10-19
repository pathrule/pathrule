// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  readSessionEtags,
  updateSessionEtags,
  resolveKnownVersion,
} from "../lib/session-cache.js";

describe("session-cache", () => {
  it("returns empty etags for unknown session", () => {
    const session = {};
    expect(readSessionEtags(session)).toEqual({});
  });

  it("persists protocol and overview versions per session", () => {
    const session = {};
    updateSessionEtags(session, {
      lastProtocolVersion: "abc12345",
      lastOverviewVersion: "def67890",
    });
    expect(readSessionEtags(session)).toEqual({
      lastProtocolVersion: "abc12345",
      lastOverviewVersion: "def67890",
    });
  });

  it("resolveKnownVersion prefers explicit client value over session cache", () => {
    const session = {};
    updateSessionEtags(session, { lastProtocolVersion: "cached-val" });
    expect(resolveKnownVersion("explicit-val", session, "lastProtocolVersion")).toBe(
      "explicit-val",
    );
  });

  it("resolveKnownVersion falls back to session cache when explicit missing", () => {
    const session = {};
    updateSessionEtags(session, { lastProtocolVersion: "cached-val" });
    expect(resolveKnownVersion(undefined, session, "lastProtocolVersion")).toBe(
      "cached-val",
    );
  });

  it("resolveKnownVersion returns undefined when neither source has a value", () => {
    const session = {};
    expect(resolveKnownVersion(undefined, session, "lastProtocolVersion")).toBeUndefined();
  });

  it("sessions are isolated — updating one does not affect another", () => {
    const s1 = {};
    const s2 = {};
    updateSessionEtags(s1, { lastProtocolVersion: "s1-val" });
    expect(readSessionEtags(s2)).toEqual({});
  });

  it("update merges patch with existing values (does not clobber)", () => {
    const session = {};
    updateSessionEtags(session, { lastProtocolVersion: "p1" });
    updateSessionEtags(session, { lastOverviewVersion: "o1" });
    expect(readSessionEtags(session)).toEqual({
      lastProtocolVersion: "p1",
      lastOverviewVersion: "o1",
    });
  });
});
