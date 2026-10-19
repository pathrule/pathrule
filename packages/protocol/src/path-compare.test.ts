// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { pathsEqual, pathStartsWith } from "./path-compare.js";

describe("path compare", () => {
  it("keeps the folder boundary on POSIX", () => {
    expect(pathStartsWith("/repo/src/a.ts", "/repo", "linux")).toBe(true);
    expect(pathStartsWith("/repo-other/a.ts", "/repo", "linux")).toBe(false);
    expect(pathsEqual("/Repo", "/repo", "linux")).toBe(false);
    expect(pathsEqual("/Repo/", "/repo", "darwin")).toBe(true);
  });

  it("reads Windows paths with backslashes, case-insensitively", () => {
    expect(pathStartsWith("C:\\Users\\me\\repo\\src\\a.ts", "C:\\Users\\me\\repo", "win32")).toBe(true);
    expect(pathStartsWith("c:\\users\\ME\\repo", "C:\\Users\\me\\repo\\", "win32")).toBe(true);
    expect(pathStartsWith("C:\\Users\\me\\repo-other", "C:\\Users\\me\\repo", "win32")).toBe(false);
    expect(pathsEqual("C:/Users/me/repo", "C:\\Users\\me\\repo", "win32")).toBe(true);
  });
});
