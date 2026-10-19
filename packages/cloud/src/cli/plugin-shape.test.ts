// SPDX-License-Identifier: Apache-2.0
// What the CLI and the MCP server check before they install the cloud's plugins: the copies of the
// shared packages each plugin resolved, its contract, and how the CLI finds it.
import { readFileSync } from "node:fs";

import { CLI_SHARED_PACKAGES } from "@pathrule/cli/plugin.js";
import { MCP_SHARED_PACKAGES } from "@pathrule/mcp/plugin.js";
import { CLI_PLUGIN_CONTRACT, MCP_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";
import { describe, expect, it } from "vitest";

import { cloudMcpPlugin } from "../mcp/plugin.js";
import cloudPluginFactory, { cloudCliPlugin } from "./plugin.js";

const SHARED = ["@pathrule/cli", "@pathrule/core", "@pathrule/integrations", "@pathrule/mcp"];
const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
// The cloud is not published on its own: the CLI and the extension bundle it with their own copies
// of the shared packages, which the workspace links as its devDependencies.
const sharedUsed = Object.keys(manifest.devDependencies ?? {})
  .filter((name) => SHARED.includes(name))
  .sort();

describe("the cloud's plugins", () => {
  it("make the CLI plugin as the default export of the CLI entry", () => {
    expect(cloudPluginFactory).toBe(cloudCliPlugin);
  });

  it("name, in the CLI plugin, the copy of every shared package the cloud uses", () => {
    const named = cloudCliPlugin().sharedPackages;
    expect(named.map((p) => p.name).sort()).toEqual(sharedUsed);
    for (const instance of named) {
      expect(CLI_SHARED_PACKAGES.find((own) => own.name === instance.name)).toBe(instance);
    }
    expect(cloudCliPlugin().contract).toBe(CLI_PLUGIN_CONTRACT);
  });

  it("name, in the MCP plugin, the server's own copies of mcp, core and integrations", () => {
    const named = cloudMcpPlugin().sharedPackages;
    expect(named.map((p) => p.name).sort()).toEqual(MCP_SHARED_PACKAGES.map((p) => p.name).sort());
    for (const instance of named) {
      expect(MCP_SHARED_PACKAGES.find((own) => own.name === instance.name)).toBe(instance);
    }
    expect(cloudMcpPlugin().contract).toBe(MCP_PLUGIN_CONTRACT);
  });

  it("read their seam contracts from their own protocol, never through a peer", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain("@pathrule/protocol");
    expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain("@pathrule/protocol");
  });

  it("turn on the official release feed's daily notice", () => {
    expect(cloudCliPlugin().passiveUpdateNotice).toBe(true);
  });
});
