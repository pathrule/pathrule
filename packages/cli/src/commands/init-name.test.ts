// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { initWorkspaceName } from "./workspace-local.js";

describe("initWorkspaceName", () => {
  it("reads --name <name> and --name=<name>", () => {
    expect(initWorkspaceName(["--local", "--name", "pathrule-growth"])).toBe("pathrule-growth");
    expect(initWorkspaceName(["--name=pathrule-growth", "--local"])).toBe("pathrule-growth");
  });
  it("prefers --name to a bare word, and still takes a bare word alone", () => {
    expect(initWorkspaceName(["other", "--name", "growth"])).toBe("growth");
    expect(initWorkspaceName(["--local", "growth"])).toBe("growth");
  });
  it("never names a workspace after a flag", () => {
    expect(initWorkspaceName(["--local", "--yes"])).toBeUndefined();
    expect(() => initWorkspaceName(["--local", "--name"])).toThrow(/--name needs a value/);
    expect(() => initWorkspaceName(["--name", "--json"])).toThrow(/--name needs a value/);
    expect(() => initWorkspaceName(["--name="])).toThrow(/--name needs a value/);
  });
});
