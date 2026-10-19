// SPDX-License-Identifier: Apache-2.0
// The MCP plugin seam refuses a plugin that cannot run with this server: one built for another
// contract, and one that resolved a second copy of a package whose state the server shares.
import { afterEach, describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { DuplicatePackageError, packageInstance } from "@pathrule/protocol/package-instance.js";
import { MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { MCP_PACKAGE } from "../package-instance.js";
import {
  installMcpPlugins,
  MCP_SHARED_PACKAGES,
  notifyToolCompleted,
  type McpPlugin,
} from "../plugin.js";

const plugin = (overrides: Partial<McpPlugin>): McpPlugin => ({
  name: "test",
  contract: MCP_PLUGIN_CONTRACT,
  sharedPackages: [],
  ...overrides,
});

afterEach(() => installMcpPlugins([]));

describe("the MCP plugin seam", () => {
  it("shares one copy of mcp, core and integrations with its plugins", () => {
    expect(MCP_SHARED_PACKAGES.map((p) => p.name)).toEqual([
      "@pathrule/mcp",
      "@pathrule/core",
      "@pathrule/integrations",
    ]);
    expect(() =>
      installMcpPlugins([
        plugin({ sharedPackages: [MCP_PACKAGE, CORE_PACKAGE, INTEGRATIONS_PACKAGE] }),
      ]),
    ).not.toThrow();
  });

  it("refuses a plugin built for another contract", () => {
    expect(() => installMcpPlugins([plugin({ contract: MCP_PLUGIN_CONTRACT + 1 })])).toThrow(
      /built for contract/,
    );
  });

  it("refuses a plugin that resolved a second copy of mcp", () => {
    const secondMcp = packageInstance(
      "@pathrule/mcp",
      "file:///prefix/node_modules/@pathrule/cloud/node_modules/@pathrule/mcp/dist/package-instance.js",
    );
    expect(() =>
      installMcpPlugins([plugin({ name: "cloud", sharedPackages: [secondMcp] })]),
    ).toThrow(DuplicatePackageError);
  });

  it("tells observers how a tool call ended, and keeps one observer's failure from the others", () => {
    const seen: Array<{ tool: string; ok: boolean; client: string | null }> = [];
    installMcpPlugins([
      plugin({
        name: "throws",
        toolCompleted: () => {
          throw new Error("observer bug");
        },
      }),
      plugin({ name: "records", toolCompleted: (event) => void seen.push(event) }),
    ]);
    notifyToolCompleted("pathrule_get_context", { ok: true, memories: [] }, "claude-code");
    notifyToolCompleted("pathrule_write_memory", { ok: false, error: { code: "x" } }, null);
    notifyToolCompleted("pathrule_ping", "pong", "cursor");
    expect(seen).toEqual([
      { tool: "pathrule_get_context", ok: true, client: "claude-code" },
      { tool: "pathrule_write_memory", ok: false, client: null },
      { tool: "pathrule_ping", ok: true, client: "cursor" },
    ]);
  });
});
