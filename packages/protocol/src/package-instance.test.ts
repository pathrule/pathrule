// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  assertSharedPackages,
  DuplicatePackageError,
  packageInstance,
} from "./package-instance.js";

describe("shared package identity", () => {
  const core = packageInstance(
    "@pathrule/core",
    "file:///app/node_modules/@pathrule/core/dist/package-instance.js",
  );
  const mcp = packageInstance(
    "@pathrule/mcp",
    "file:///app/node_modules/@pathrule/mcp/dist/package-instance.js",
  );

  it("accepts a plugin that resolved the host's copies", () => {
    expect(() =>
      assertSharedPackages({ seam: "CLI", plugin: "p", host: [core, mcp], resolved: [core, mcp] }),
    ).not.toThrow();
  });

  it("ignores a package the host does not share", () => {
    const other = packageInstance("@pathrule/other", "file:///x");
    expect(() =>
      assertSharedPackages({ seam: "CLI", plugin: "p", host: [core], resolved: [other] }),
    ).not.toThrow();
  });

  it("refuses a second copy, and names both locations", () => {
    // Same name and location, but another token: another evaluation of the token module, which is
    // what a second copy is.
    const nested = packageInstance(
      "@pathrule/core",
      "file:///app/node_modules/@pathrule/intelligence-engine/node_modules/@pathrule/core/dist/package-instance.js",
    );
    let error: unknown;
    try {
      assertSharedPackages({
        seam: "CLI",
        plugin: "intelligence-engine",
        host: [core, mcp],
        resolved: [nested],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DuplicatePackageError);
    const duplicate = error as DuplicatePackageError;
    expect(duplicate.packageName).toBe("@pathrule/core");
    expect(duplicate.message).toContain(
      'The CLI plugin "intelligence-engine" loaded a second copy of @pathrule/core',
    );
    expect(duplicate.message).toContain(core.location);
    expect(duplicate.message).toContain(nested.location);
  });

  it("tells two copies apart even when they report the same location", () => {
    const again = packageInstance(core.name, core.location);
    expect(() =>
      assertSharedPackages({ seam: "MCP", plugin: "p", host: [core], resolved: [again] }),
    ).toThrow(DuplicatePackageError);
  });

  it("freezes a token", () => {
    expect(Object.isFrozen(core)).toBe(true);
  });
});
