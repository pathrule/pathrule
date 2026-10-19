// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { MIN_NODE_VERSION, isNodeVersionSupported, parseSemver } from "./node-version.js";

describe("parseSemver", () => {
  it("parses normal Node version strings", () => {
    expect(parseSemver("20.11.1")).toEqual({ major: 20, minor: 11, patch: 1 });
    expect(parseSemver("v22.4.0")).toEqual({ major: 22, minor: 4, patch: 0 });
  });

  it("strips pre-release and build metadata", () => {
    expect(parseSemver("20.11.1-nightly20260101")).toEqual({ major: 20, minor: 11, patch: 1 });
    expect(parseSemver("20.11.1+abc123")).toEqual({ major: 20, minor: 11, patch: 1 });
  });

  it("returns null on unparseable input", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("20.11")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("isNodeVersionSupported", () => {
  it("accepts the minimum supported version", () => {
    expect(isNodeVersionSupported(MIN_NODE_VERSION)).toBe(true);
  });

  it("rejects older patch / minor / major versions", () => {
    expect(isNodeVersionSupported("22.13.1")).toBe(false);
    expect(isNodeVersionSupported("21.99.99")).toBe(false);
    expect(isNodeVersionSupported("20.18.0")).toBe(false);
  });

  it("accepts newer patch / minor / major versions", () => {
    expect(isNodeVersionSupported("22.14.1")).toBe(true);
    expect(isNodeVersionSupported("22.15.0")).toBe(true);
    expect(isNodeVersionSupported("24.0.0")).toBe(true);
  });

  it("lets unknown runtimes through rather than crashing the CLI", () => {
    expect(isNodeVersionSupported("not-a-version")).toBe(true);
  });
});
