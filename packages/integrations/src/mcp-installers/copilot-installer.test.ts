// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { copilotCliInstaller, copilotVscodeInstaller } from "./copilot-installer.js";
import type { McpServerEntry } from "../mcp-types.js";

const ENTRY: McpServerEntry = {
  type: "stdio",
  command: "/usr/local/bin/node",
  args: ["/opt/pathrule/cli/index.js", "mcp", "run"],
  env: { PATHRULE_EXAMPLE_URL: "https://api.example.com", PATHRULE_EXAMPLE_KEY: "key" },
};

describe("copilotCliInstaller (~/.copilot/mcp-config.json)", () => {
  it("computes the config path per platform", () => {
    expect(copilotCliInstaller.homeConfigPath("/Users/pat", "darwin")).toBe(
      "/Users/pat/.copilot/mcp-config.json",
    );
    expect(copilotCliInstaller.homeConfigPath("/home/pat", "linux")).toBe(
      "/home/pat/.copilot/mcp-config.json",
    );
    expect(copilotCliInstaller.homeConfigPath("C:\\Users\\Pat Smith", "win32")).toBe(
      "C:\\Users\\Pat Smith\\.copilot\\mcp-config.json",
    );
  });

  it("writes the Copilot CLI entry shape: mcpServers root, type local, tools allowlist", () => {
    const { body, wasNew } = copilotCliInstaller.inject(null, ENTRY);
    expect(wasNew).toBe(true);
    const parsed = JSON.parse(body) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = parsed.mcpServers.pathrule!;
    expect(entry.type).toBe("local");
    expect(entry.tools).toEqual(["*"]);
    expect(entry.command).toBe(ENTRY.command);
    expect(entry.args).toEqual(ENTRY.args);
  });

  it("round-trips: inject → read → remove preserves foreign entries", () => {
    const existing = JSON.stringify({
      mcpServers: { sentry: { type: "local", command: "sentry-mcp", args: [], tools: ["*"] } },
    });
    const injected = copilotCliInstaller.inject(existing, ENTRY);
    expect(copilotCliInstaller.read(injected.body)?.command).toBe(ENTRY.command);
    const removed = copilotCliInstaller.remove(injected.body);
    expect(removed.wasPresent).toBe(true);
    const after = JSON.parse(removed.body!) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(after.mcpServers)).toEqual(["sentry"]);
  });

  it("drops the file entirely when removal leaves nothing but an empty map", () => {
    const { body } = copilotCliInstaller.inject(null, ENTRY);
    const removed = copilotCliInstaller.remove(body);
    expect(removed.wasPresent).toBe(true);
    expect(removed.body).toBeNull();
  });
});

describe("copilotVscodeInstaller (user-profile mcp.json)", () => {
  it("computes the user-profile path per platform", () => {
    expect(copilotVscodeInstaller.homeConfigPath("/Users/pat", "darwin")).toBe(
      "/Users/pat/Library/Application Support/Code/User/mcp.json",
    );
    expect(copilotVscodeInstaller.homeConfigPath("/home/pat", "linux")).toBe(
      "/home/pat/.config/Code/User/mcp.json",
    );
    expect(copilotVscodeInstaller.homeConfigPath("C:\\Users\\Pat Smith", "win32")).toBe(
      "C:\\Users\\Pat Smith\\AppData\\Roaming\\Code\\User\\mcp.json",
    );
  });

  it("writes under the `servers` root key (NOT mcpServers) with type stdio", () => {
    const { body } = copilotVscodeInstaller.inject(null, ENTRY);
    const parsed = JSON.parse(body) as { servers: Record<string, Record<string, unknown>> };
    expect(parsed.servers.pathrule!.type).toBe("stdio");
    expect("mcpServers" in parsed).toBe(false);
  });

  it("preserves foreign servers and unrelated root keys", () => {
    const existing = JSON.stringify({
      servers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp" } },
      inputs: [{ id: "token", type: "promptString" }],
    });
    const injected = copilotVscodeInstaller.inject(existing, ENTRY);
    const parsed = JSON.parse(injected.body) as Record<string, unknown>;
    const servers = parsed.servers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["github", "pathrule"]);
    expect(Array.isArray(parsed.inputs)).toBe(true);
    const removed = copilotVscodeInstaller.remove(injected.body);
    expect(removed.body).not.toBeNull(); // github entry + inputs survive
  });

  it("both installers share the copilot id and carry disambiguating labels", () => {
    expect(copilotCliInstaller.id).toBe("copilot");
    expect(copilotVscodeInstaller.id).toBe("copilot");
    expect(copilotCliInstaller.configLabel).not.toBe(copilotVscodeInstaller.configLabel);
  });
});
