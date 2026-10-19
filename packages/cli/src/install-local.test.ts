// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  homeConfigPath: vi.fn(),
  inject: vi.fn(),
}));

vi.mock("@pathrule/integrations/mcp-installers/registry.js", () => ({
  getInstallers: vi.fn(() => [
    { homeConfigPath: mocks.homeConfigPath, inject: mocks.inject, remove: vi.fn(), read: vi.fn() },
  ]),
}));

import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import { installCliMcpTargets, resolveMcpServerEntry } from "./install-local.js";
import { installCliPlugins, type CliAccountEdition } from "./plugin.js";

// One entry for every folder: the spawned `pathrule mcp run` resolves each call's folder, so the
// entry names no edition (no PATHRULE_LOCAL) and carries no account configuration of its own.
describe("resolveMcpServerEntry", () => {
  it("launches the bundled CLI `mcp run` and names no edition", () => {
    const entry = resolveMcpServerEntry({});
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe(process.execPath);
    expect(entry.args.length).toBe(3);
    expect(entry.args[1]).toBe("mcp");
    expect(entry.args[2]).toBe("run");
    expect(entry.args[0]).not.toMatch(/^file:/);
    expect(entry.args[0]).toMatch(/(^\/|^[A-Z]:\\)/);
    expect(entry.env).toEqual({});
  });

  it("propagates PATHRULE_HOME, a Cloud named for this run, and proxy/CA passthrough", () => {
    const entry = resolveMcpServerEntry({
      PATHRULE_HOME: "/custom/pathrule home",
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.staging.example",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-staging",
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-bundle.pem",
    });
    expect(entry.env).toEqual({
      PATHRULE_HOME: "/custom/pathrule home",
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.staging.example",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-staging",
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-bundle.pem",
    });
    expect(resolveMcpServerEntry({}).env).not.toHaveProperty("PATHRULE_HOME");
  });
});

// `pathrule install`: the same entry with or without an account edition, after checking the target.
describe("installCliMcpTargets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pathrule-cli-install-edition-"));
    vi.clearAllMocks();
    mocks.homeConfigPath.mockReturnValue(join(root, "config.json"));
    mocks.inject.mockImplementation((_existing, entry) => ({
      body: JSON.stringify({ entry }),
      wasNew: true,
    }));
  });

  afterEach(async () => {
    installCliPlugins([]);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const written = async () =>
    (
      JSON.parse(await readFile(join(root, "config.json"), "utf8")) as {
        entry: { env: Record<string, string>; args: string[] };
      }
    ).entry;

  it("writes one edition-neutral entry, account edition installed or not", async () => {
    installCliPlugins([]);
    expect((await installCliMcpTargets("codex", {})).map((r) => r.status)).toEqual(["installed"]);
    const open = await written();
    expect(open.env).toEqual({});

    const mcpEntry = vi.fn();
    const account = { commands: {}, mcpEntry } as unknown as CliAccountEdition;
    installCliPlugins([{ name: "account", contract: CLI_PLUGIN_CONTRACT, sharedPackages: [], account }]);
    await expect(installCliMcpTargets("nope", {})).rejects.toThrow("invalid_install_target");
    await installCliMcpTargets("codex", {});
    expect(await written()).toEqual(open);
    expect(mcpEntry).not.toHaveBeenCalled();
  });
});
