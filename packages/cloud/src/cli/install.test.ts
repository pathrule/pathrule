// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  homeConfigPath: vi.fn(),
  inject: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@pathrule/integrations/mcp-installers/registry.js", () => ({
  getInstallers: vi.fn(() => [
    {
      homeConfigPath: mocks.homeConfigPath,
      inject: mocks.inject,
      remove: mocks.remove,
      read: vi.fn(),
    },
  ]),
}));

import { installLocalCliTargets } from "@pathrule/cli/install-local.js";

import { installCliTargets, installSetupMcpEntries, resolveCliMcpEntry } from "./install.js";

describe("installCliTargets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pathrule-cli-install-"));
    vi.clearAllMocks();
    mocks.inject.mockImplementation((_existing, entry) => ({
      body: JSON.stringify({ entry }),
      wasNew: true,
    }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("writes Pathrule Cloud's public names into the MCP entry, and nothing of any backend secret", async () => {
    const configPath = join(root, "codex-config.json");
    const env = {
      PATHRULE_UPDATE_POLICY: "manual",
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
    };
    mocks.homeConfigPath.mockReturnValue(configPath);

    const results = await installCliTargets("codex", env);

    expect(results).toEqual([
      {
        client: "codex",
        ok: true,
        status: "installed",
        config_path: configPath,
        was_new: true,
      },
    ]);
    expect(mocks.inject).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: "stdio",
        env: {
          PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io",
          PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
        },
      }),
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      entry: { env: { PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io" } },
    });
  });
});

describe("resolveCliMcpEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("launches the bundled CLI entrypoint via process.execPath and `mcp run`", () => {
    const entry = resolveCliMcpEntry({});
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe(process.execPath);
    expect(entry.args.length).toBe(3);
    expect(entry.args[1]).toBe("mcp");
    expect(entry.args[2]).toBe("run");
    // The first arg must be an absolute filesystem path to the bundled CLI,
    // never a repo-relative stale path or a file:// URL.
    expect(entry.args[0]).not.toMatch(/^file:/);
    expect(entry.args[0]).not.toMatch(/mcp-server\/dist\/index\.js$/);
    expect(entry.args[0]).toMatch(/(^\/|^[A-Z]:\\)/);
  });

  it("carries Pathrule Cloud's public names, and nothing of the legacy backend, when the run names it", () => {
    const entry = resolveCliMcpEntry({
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
      PATHRULE_HOME: "/home/p/.pathrule",
    });
    expect(entry.env).toEqual({
      PATHRULE_NATIVE_CLOUD_URL: "https://cloud.pathrule.io",
      PATHRULE_NATIVE_DEVICE_CLIENT_ID: "pathrule-cli-production",
      PATHRULE_HOME: "/home/p/.pathrule",
    });
  });

  it("carries no backend at all where the run names no Pathrule Cloud", () => {
    expect(resolveCliMcpEntry({}).env).toEqual({});
  });

  it("propagates PATHRULE_HOME when set", () => {
    const entry = resolveCliMcpEntry({ PATHRULE_HOME: "/custom/pathrule home" });
    expect(entry.env).toMatchObject({
      PATHRULE_HOME: "/custom/pathrule home",
    });
  });

  it("omits PATHRULE_HOME when unset or empty", () => {
    expect(resolveCliMcpEntry({}).env).not.toHaveProperty("PATHRULE_HOME");
    expect(resolveCliMcpEntry({ PATHRULE_HOME: "" }).env).not.toHaveProperty("PATHRULE_HOME");
    expect(resolveCliMcpEntry({ PATHRULE_HOME: "   " }).env).not.toHaveProperty("PATHRULE_HOME");
  });

  it("propagates corporate proxy + custom CA env values when present", () => {
    const entry = resolveCliMcpEntry({
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      HTTP_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-bundle.pem",
    });
    expect(entry.env).toMatchObject({
      HTTPS_PROXY: "http://proxy.corp.example:8080",
      HTTP_PROXY: "http://proxy.corp.example:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-bundle.pem",
    });
  });

  it("omits proxy env keys when unset", () => {
    const entry = resolveCliMcpEntry({});
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]) {
      expect(entry.env).not.toHaveProperty(key);
    }
  });
});

// The open installer, with the account edition's modules loaded: one entry for every folder, which
// names no edition and no account.
describe("installLocalCliTargets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pathrule-cli-install-local-"));
    vi.clearAllMocks();
    mocks.inject.mockImplementation((_existing, entry) => ({
      body: JSON.stringify({ entry }),
      wasNew: true,
    }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("injects the one entry, which names no edition and no account", async () => {
    const configPath = join(root, "claude-config.json");
    mocks.homeConfigPath.mockReturnValue(configPath);

    const results = await installLocalCliTargets("claude", {});

    expect(results).toEqual([
      {
        client: "claude-code",
        ok: true,
        status: "installed",
        config_path: configPath,
        was_new: true,
      },
    ]);
    const written = JSON.parse(await readFile(configPath, "utf8")) as {
      entry: { env: Record<string, string>; args: string[] };
    };
    expect(written.entry.env).toEqual({});
    expect(written.entry.args.slice(-2)).toEqual(["mcp", "run"]);
  });
});

// `pathrule setup` on Pathrule Cloud: a line per client config, and a failed setup only when no
// client got its entry.
describe("installSetupMcpEntries", () => {
  let root: string;
  const mode = { json: false, color: false, interactive: false };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pathrule-cli-install-setup-"));
    vi.clearAllMocks();
    mocks.homeConfigPath.mockImplementation(() => join(root, "config.json"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("says each client's result, and fails only when every client failed", async () => {
    let calls = 0;
    mocks.inject.mockImplementation((_existing, entry) => {
      calls += 1;
      if (calls === 2) throw new Error("config is not JSON");
      return { body: JSON.stringify({ entry }), wasNew: true };
    });
    const some = await installSetupMcpEntries(null, {}, mode);
    expect(some.failed).toBe(false);
    expect(some.results).toHaveLength(5);
    expect(some.lines.filter((l) => l.startsWith("[ok] "))).toHaveLength(4);
    expect(some.lines.filter((l) => l.startsWith("[warn] "))).toEqual([
      expect.stringMatching(/: MCP entry not installed: config is not JSON \(.+config\.json\)$/),
    ]);

    mocks.inject.mockImplementation(() => {
      throw new Error("read-only file system");
    });
    const none = await installSetupMcpEntries("codex", {}, mode);
    expect(none.failed).toBe(true);
    expect(none.lines).toEqual([expect.stringContaining("[warn] codex: MCP entry not installed")]);
  });

  it("refuses an AI client it does not know, writing nothing", async () => {
    const unknown = await installSetupMcpEntries("notepad", {}, mode);
    expect(unknown).toMatchObject({ failed: true, results: [] });
    expect(unknown.lines[0]).toContain("--target notepad is not an AI client Pathrule knows");
    expect(mocks.inject).not.toHaveBeenCalled();
  });
});
