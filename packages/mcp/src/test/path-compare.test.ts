// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isCaseInsensitiveFs,
  pathsEqual,
  pathStartsWith,
} from "@pathrule/protocol/path-compare.js";

describe("isCaseInsensitiveFs", () => {
  it("returns true on darwin and win32", () => {
    expect(isCaseInsensitiveFs("darwin")).toBe(true);
    expect(isCaseInsensitiveFs("win32")).toBe(true);
  });
  it("returns false on linux", () => {
    expect(isCaseInsensitiveFs("linux")).toBe(false);
  });
});

describe("pathsEqual", () => {
  it("matches identical paths on every platform", () => {
    expect(pathsEqual("/Users/a/repo", "/Users/a/repo", "darwin")).toBe(true);
    expect(pathsEqual("/Users/a/repo", "/Users/a/repo", "linux")).toBe(true);
  });

  it("treats case-only differences as equal on darwin / win32", () => {
    expect(pathsEqual("/Users/a/GitHub/repo", "/Users/a/Github/repo", "darwin")).toBe(true);
    expect(pathsEqual("C:\\Users\\A\\Repo", "c:\\users\\a\\repo", "win32")).toBe(true);
  });

  it("rejects case-only differences on linux", () => {
    expect(pathsEqual("/Users/a/GitHub/repo", "/Users/a/Github/repo", "linux")).toBe(false);
  });

  it("tolerates trailing slashes on either side", () => {
    expect(pathsEqual("/Users/a/repo/", "/Users/a/repo", "darwin")).toBe(true);
    expect(pathsEqual("/Users/a/repo", "/Users/a/repo///", "linux")).toBe(true);
  });
});

describe("pathStartsWith", () => {
  it("matches child === parent (with or without trailing slash)", () => {
    expect(pathStartsWith("/Users/a/repo", "/Users/a/repo", "linux")).toBe(true);
    expect(pathStartsWith("/Users/a/repo/", "/Users/a/repo", "linux")).toBe(true);
  });

  it("matches a proper descendant", () => {
    expect(pathStartsWith("/Users/a/repo/src", "/Users/a/repo", "linux")).toBe(true);
  });

  it("does NOT match a sibling that shares a letter-for-letter prefix", () => {
    expect(pathStartsWith("/Users/a/repo-other/src", "/Users/a/repo", "linux")).toBe(false);
  });

  it("accepts case-only differences on case-insensitive platforms", () => {
    expect(
      pathStartsWith(
        "/Users/a/Github/pathrule-web/apps",
        "/Users/a/GitHub/pathrule-web",
        "darwin",
      ),
    ).toBe(true);
  });

  it("rejects case-only differences on linux", () => {
    expect(
      pathStartsWith(
        "/Users/a/Github/pathrule-web/apps",
        "/Users/a/GitHub/pathrule-web",
        "linux",
      ),
    ).toBe(false);
  });
});
