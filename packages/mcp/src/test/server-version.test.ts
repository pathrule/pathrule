// SPDX-License-Identifier: Apache-2.0
// The MCP server says which version it is, which contracts it speaks, and, from the release
// manifest on disk only, which component is outdated, how to update it and whether a restart is
// needed. A Cloud release that still accepts its contracts asks nothing.
import { removeScratch } from "./scratch.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  release,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import { fetchReleaseManifest } from "@pathrule/core/release/release-feed.js";
import { PATHRULE_CONTRACTS } from "@pathrule/protocol/compatibility.js";
import type { ReleaseManifest } from "@pathrule/protocol/release-manifest.js";

import { startPathruleMcpServer } from "../server.js";
import {
  compatibilityInstruction,
  mcpCompatibilityReport,
  resetSessionNotices,
  setMcpServerVersion,
  takeSessionNotice,
} from "../server-version.js";

let untrust: () => void;
beforeAll(() => {
  untrust = trustTestReleaseKey();
});
afterAll(() => untrust());

const originalHome = process.env.PATHRULE_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-mcp-version-"));
  process.env.PATHRULE_HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.PATHRULE_HOME;
  else process.env.PATHRULE_HOME = originalHome;
  setMcpServerVersion({ version: "0.0.0-dev", installedVersion: () => null, distribution: "npm" });
  removeScratch(home);
});

async function remember(manifest: ReleaseManifest): Promise<void> {
  const result = await fetchReleaseManifest({
    env: { PATHRULE_HOME: home },
    fetchImpl: serving(signedBody(manifest)),
    userAgent: "test",
  });
  if (!result.ok) throw new Error(result.detail);
}

async function connect(options: Parameters<typeof startPathruleMcpServer>[0]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startPathruleMcpServer({ transport: serverTransport, stdioSafe: false, ...options });
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("the server's version", () => {
  it("is the CLI's version at initialize and in pathrule_ping, with its contracts", async () => {
    const client = await connect({ version: "1.4.2" });
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "pathrule", version: "1.4.2" });
      expect(client.getInstructions()).toBeUndefined();
      const ping = await client.callTool({ name: "pathrule_ping", arguments: {} });
      const body = JSON.parse((ping.content as Array<{ text: string }>)[0]!.text);
      expect(body.version).toBe("1.4.2");
      expect(body.compatibility.server).toEqual({
        name: "pathrule",
        version: "1.4.2",
        contracts: PATHRULE_CONTRACTS,
      });
      expect(body.compatibility.issues).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("asks for a restart when a newer version is installed under a running session", async () => {
    const client = await connect({ version: "1.0.0", installedVersion: () => "1.0.1" });
    try {
      expect(client.getInstructions()).toBe(
        "Tell the user, once: Pathrule 1.0.1 is installed, but this session's MCP server still runs 1.0.0. Restart this agent session to activate the new version.",
      );
    } finally {
      await client.close();
    }
  });
});

describe("compatibility from the release manifest on disk", () => {
  it("asks nothing when Cloud still accepts the server's contracts", async () => {
    setMcpServerVersion({ version: "1.0.0" });
    await remember(
      testManifest({
        cli: cliComponent({ npm: { latest: release("1.0.0") } }),
        cloud: { restart: "none", accepts: { cloud_api: { min: 1, max: 5 } }, channels: {} },
      }),
    );
    const report = mcpCompatibilityReport({
      env: { PATHRULE_HOME: home },
      clientId: "claude-code",
    });
    expect(report.issues).toEqual([]);
    expect(compatibilityInstruction(report)).toBeNull();
  });

  it("names the outdated server when Cloud no longer accepts it", async () => {
    setMcpServerVersion({ version: "1.0.0" });
    await remember(
      testManifest({
        cloud: { restart: "none", accepts: { cloud_api: { min: 2, max: 2 } }, channels: {} },
      }),
    );
    const report = mcpCompatibilityReport({
      env: { PATHRULE_HOME: home },
      clientId: "claude-code",
    });
    expect(report.issues).toEqual([
      {
        component: "mcp-server",
        kind: "update_required",
        message:
          "Your Pathrule MCP server is outdated. Update it to continue using the latest Cloud capabilities.",
        action: "Run `pathrule update` in a terminal, then restart this agent session.",
      },
    ]);
    expect(compatibilityInstruction(report)).toContain("Your Pathrule MCP server is outdated.");
  });

  it("mentions an optional update in ping only, never in the instructions", async () => {
    setMcpServerVersion({ version: "1.0.0" });
    await remember(testManifest({ cli: cliComponent({ npm: { latest: release("1.0.1") } }) }));
    const report = mcpCompatibilityReport({ env: { PATHRULE_HOME: home }, clientId: null });
    expect(report.issues).toMatchObject([{ kind: "update_available" }]);
    expect(compatibilityInstruction(report)).toBeNull();
  });

  it("uses the install's own channel: nothing for Homebrew before Homebrew has it, nothing for an editor install", async () => {
    await remember(
      testManifest({
        cli: cliComponent({
          npm: { latest: release("1.0.1") },
          homebrew: { latest: release("1.0.0") },
        }),
      }),
    );
    setMcpServerVersion({ version: "1.0.0", distribution: "homebrew" });
    expect(mcpCompatibilityReport({ env: { PATHRULE_HOME: home }, clientId: null }).issues).toEqual(
      [],
    );
    setMcpServerVersion({ version: "1.0.0", distribution: null });
    expect(mcpCompatibilityReport({ env: { PATHRULE_HOME: home }, clientId: null }).issues).toEqual(
      [],
    );
  });

  it("names an agent plugin older than the minimum, with its host's update path", async () => {
    setMcpServerVersion({ version: "1.0.0" });
    await remember(
      testManifest({
        "claude-code-plugin": {
          restart: "new-session",
          minimum_version: "1.0.0",
          channels: { "claude-marketplace": { latest: release("1.0.1") } },
        },
      }),
    );
    const report = mcpCompatibilityReport({
      env: { PATHRULE_HOME: home, PATHRULE_PLUGIN_VERSION: "0.9.0" },
      clientId: "claude-code",
    });
    expect(report.plugin).toEqual({ version: "0.9.0", host: "claude-code" });
    expect(report.issues).toMatchObject([
      {
        component: "agent-plugin",
        kind: "update_required",
        action: expect.stringContaining("/reload-plugins"),
      },
    ]);
  });
});

describe("a notice during a session", () => {
  afterEach(() => resetSessionNotices());

  it("tells the user once, inside the next tool result, that an update needs a restart", async () => {
    let onDisk = "1.0.0";
    const client = await connect({ version: "1.0.0", installedVersion: () => onDisk });
    try {
      const call = async () =>
        JSON.parse(
          (
            (await client.callTool({ name: "pathrule_ping", arguments: {} })).content as Array<{
              text: string;
            }>
          )[0]!.text,
        );
      expect((await call())._pathrule_notice).toBeUndefined();
      onDisk = "1.0.1"; // `pathrule update` (or the automatic update) installed a new version
      resetSessionNotices(); // the next look is due (a minute passes)
      expect((await call())._pathrule_notice).toBe(
        "Tell the user once: Pathrule 1.0.1 is installed, but this session's MCP server still runs 1.0.0. Restart this agent session to activate the new version.",
      );
      expect((await call())._pathrule_notice).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("looks at the disk at most once a minute", () => {
    setMcpServerVersion({ version: "1.0.0", installedVersion: () => "1.0.1" });
    expect(takeSessionNotice({ PATHRULE_HOME: home }, null, 1_000_000)).toContain(
      "Restart this agent session",
    );
    resetSessionNotices();
    takeSessionNotice({ PATHRULE_HOME: home }, null, 2_000_000);
    expect(takeSessionNotice({ PATHRULE_HOME: home }, null, 2_030_000)).toBeNull();
  });
});
