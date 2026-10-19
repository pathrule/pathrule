// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { resolveMcpServerEntry } from "#cli/install-local.js";

import { buildExtensionMcpEntry } from "../integration/mcp-entry.js";

const env = {
  PATHRULE_HOME: "/home/ada/.pathrule",
  PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example.test",
  // Never travel: an edition marker nothing reads, and anything secret.
  PATHRULE_LOCAL: "1",
  PATHRULE_TOKEN: "secret",
  HOME: "/home/ada",
} as NodeJS.ProcessEnv;

const base = {
  bundledCliPath: "/ext/dist/cli/dist/index.js",
  execPath: "/apps/VSCode/electron",
  env,
};

describe("buildExtensionMcpEntry: one entry for every folder, naming no edition", () => {
  it("is the CLI's entry, launched with the extension's bundled CLI", () => {
    const entry = buildExtensionMcpEntry({ ...base, runtime: "node" });
    const cli = resolveMcpServerEntry(env);
    expect(entry).toEqual({
      type: "stdio",
      command: "node",
      args: ["/ext/dist/cli/dist/index.js", "mcp", "run"],
      env: cli.env,
    });
    expect(entry.env).toEqual({
      PATHRULE_HOME: "/home/ada/.pathrule",
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.example.test",
    });
    expect(entry.env).not.toHaveProperty("PATHRULE_LOCAL");
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("names nothing at all when the run names nothing", () => {
    expect(buildExtensionMcpEntry({ ...base, env: {}, runtime: "node" }).env).toEqual({});
  });

  it("electron runtime spawns the host binary as node", () => {
    const entry = buildExtensionMcpEntry({ ...base, runtime: "electron" });
    expect(entry.command).toBe("/apps/VSCode/electron");
    expect(entry.args).toEqual(["/ext/dist/cli/dist/index.js", "mcp", "run"]);
    expect(entry.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      PATHRULE_HOME: "/home/ada/.pathrule",
    });
    expect(entry.env).not.toHaveProperty("PATHRULE_LOCAL");
  });
});
