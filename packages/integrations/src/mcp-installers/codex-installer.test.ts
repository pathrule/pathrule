// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { codexInstaller } from "./codex-installer.js";
import type { McpServerEntry } from "../mcp-types.js";

const ENTRY: McpServerEntry = {
  type: "stdio",
  command: "/usr/bin/node",
  args: ["/abs/mcp-server/dist/index.js"],
  env: { PATHRULE_MCP_TOOLS: "all", PATHRULE_EXAMPLE_URL: "https://api.example.com" },
};

describe("codexInstaller", () => {
  it("injects, reads back, and round-trips the managed entry", () => {
    const { body, wasNew } = codexInstaller.inject(null, ENTRY);
    expect(wasNew).toBe(true);
    expect(codexInstaller.read(body)).toEqual(ENTRY);
  });

  it("is idempotent on re-inject (same entry read back)", () => {
    const first = codexInstaller.inject(null, ENTRY).body;
    const second = codexInstaller.inject(first, ENTRY);
    expect(second.wasNew).toBe(false);
    expect(codexInstaller.read(second.body)).toEqual(ENTRY);
  });

  // Grok reuse: its ~/.grok/config.toml carries unrelated top-level tables that
  // must survive the inject (engine-mcp.ts writes the grok config through this
  // same installer because the [mcp_servers.*] shape is identical to Codex's).
  it("preserves grok's other top-level tables when injecting", () => {
    const grokConfig = `[cli]
installer = "internal"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"
`;
    const { body } = codexInstaller.inject(grokConfig, ENTRY);
    const parsed = parse(body) as Record<string, any>;
    // Managed MCP entry landed in the shape grok reads.
    expect(parsed.mcp_servers.pathrule.command).toBe("/usr/bin/node");
    expect(parsed.mcp_servers.pathrule.enabled).toBe(true);
    expect(parsed.mcp_servers.pathrule.env.PATHRULE_MCP_TOOLS).toBe("all");
    // Grok's own config is untouched.
    expect(parsed.cli.installer).toBe("internal");
    expect(parsed.marketplace.official_marketplace_auto_installed).toBe(true);
    expect(parsed.marketplace.sources[0].name).toBe("xAI Official");
    expect(codexInstaller.read(body)).toEqual(ENTRY);
  });
});
