// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  offline,
  release,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import type { HostPluginState } from "@pathrule/integrations/native/host-plugin-state.js";

import { fetchReleaseManifest } from "@pathrule/core/release/release-feed.js";

import { runCliDoctor } from "../doctor.js";
import { pendingPluginNotice } from "../update-check.js";
import { pluginCheck } from "./components.js";

const state = (over: Partial<HostPluginState> = {}): HostPluginState => ({
  host: "claude-code",
  installed: true,
  id: "pathrule@pathrule",
  version: "1.0.0",
  installPath: "/x",
  marketplace: { name: "pathrule", source: "github", location: "pathrule/pathrule" },
  autoUpdate: false,
  autoUpdateReason: "off by default for this marketplace",
  launcher: { version: "1.0.0", minRuntime: "1.0.0", launcherContract: 1 },
  ...over,
});

const manifest = testManifest({
  "claude-code-plugin": {
    restart: "new-session",
    channels: { "claude-marketplace": { latest: release("1.0.2") } },
  },
});

describe("an agent plugin's row", () => {
  it("shows the host's own update commands when its automatic updates are off", () => {
    const check = pluginCheck(state(), { manifest, runtimeVersion: "1.0.2", cliVersion: "1.0.2" });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1.0.2 is available (installed 1.0.0");
    expect(check.detail).toContain(
      "Run: claude plugin marketplace update pathrule && claude plugin update pathrule@pathrule",
    );
    expect(check.detail).toContain("/reload-plugins or in a new session");
  });

  it("leaves the update to the host when it updates plugins by itself", () => {
    const check = pluginCheck(state({ autoUpdate: true }), {
      manifest,
      runtimeVersion: "1.0.2",
      cliVersion: "1.0.2",
    });
    expect(check).toMatchObject({ status: "pass" });
    expect(check.detail).toContain("Claude Code updates it to 1.0.2 by itself");
  });

  it("fails when the plugin needs a newer runtime than the one it launches", () => {
    const check = pluginCheck(
      state({ launcher: { version: "1.1.0", minRuntime: "1.1.0", launcherContract: 1 } }),
      {
        manifest,
        runtimeVersion: "1.0.0",
        cliVersion: "1.0.0",
      },
    );
    expect(check).toMatchObject({ status: "fail" });
    expect(check.detail).toContain(
      "needs Pathrule 1.1.0 or newer; the runtime is 1.0.0. Run: pathrule update",
    );
  });

  it("fails on another launcher contract and names the side to update", () => {
    const older = pluginCheck(
      state({ launcher: { version: "0.9.0", minRuntime: "0.9.0", launcherContract: 0 } }),
      {
        manifest,
        runtimeVersion: "1.0.0",
        cliVersion: "1.0.0",
      },
    );
    expect(older.status).toBe("fail");
    expect(older.detail).toContain("update the plugin");
    const newer = pluginCheck(
      state({ launcher: { version: "2.0.0", minRuntime: "1.0.0", launcherContract: 2 } }),
      {
        manifest,
        runtimeVersion: "1.0.0",
        cliVersion: "1.0.0",
      },
    );
    expect(newer.detail).toContain("update Pathrule (pathrule update)");
  });

  it("compares a locally written marketplace with this CLI, not the public channel", () => {
    const local = state({
      marketplace: {
        name: "pathrule",
        source: "directory",
        location: "/h/.pathrule/integrations/marketplace",
      },
    });
    const check = pluginCheck(local, {
      manifest: null,
      runtimeVersion: "1.0.1",
      cliVersion: "1.0.1",
      env: { PATHRULE_HOME: "/h/.pathrule" },
    });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      "Run: pathrule integrations repair && claude plugin marketplace update pathrule",
    );
  });

  it("is quiet without a verified release to compare with", () => {
    expect(
      pluginCheck(state(), { manifest: null, runtimeVersion: "1.0.0", cliVersion: "1.0.0" }).status,
    ).toBe("pass");
  });
});

describe("pathrule doctor's updates section", () => {
  let untrust: () => void;
  beforeAll(() => {
    untrust = trustTestReleaseKey();
  });
  afterAll(() => untrust());

  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pathrule-doctor-updates-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function seedClaudePlugin(): void {
    const installPath = join(home, ".claude", "plugins", "cache", "pathrule", "pathrule", "1.0.0");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "pathrule@pathrule": [{ scope: "user", installPath, version: "1.0.0" }] },
      }),
    );
  }
  const body = () =>
    signedBody(
      testManifest({
        cli: cliComponent({ npm: { latest: release("99.0.0") } }),
        "claude-code-plugin": {
          restart: "new-session",
          channels: { "claude-marketplace": { latest: release("1.0.2") } },
        },
      }),
    );

  it("reports a verified release and the agent plugin, and stays ok offline", async () => {
    seedClaudePlugin();
    // A person at a terminal with a stale (here: empty) copy: doctor asks the release service.
    const env = { PATHRULE_HOME: join(home, ".pathrule"), HOME: home };
    const report = await runCliDoctor(env, home, { fetchImpl: serving(body()), interactive: true });
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["cli_version", "update_checks", "plugin_claude_code"]),
    );
    expect(report.checks.find((c) => c.name === "cli_version")?.detail).toContain(
      "99.0.0 is available",
    );
    expect(report.checks.find((c) => c.name === "plugin_claude_code")?.status).toBe("warn");

    const quiet = await runCliDoctor(env, home, { fetchImpl: offline, interactive: true });
    expect(quiet.checks.find((c) => c.name === "cli_version")?.detail).toContain(
      "99.0.0 is available",
    );
    const fresh = await runCliDoctor({ ...env, PATHRULE_HOME: join(home, "other") }, home, {
      fetchImpl: offline,
      interactive: true,
    });
    expect(fresh.checks.find((c) => c.name === "cli_version")).toMatchObject({ status: "pass" });
    expect(fresh.checks.find((c) => c.name === "cli_version")?.detail).toContain(
      "could not check for updates (offline)",
    );
  });

  it("sends nothing outside a terminal (--json, a pipe, CI), and answers from disk", async () => {
    seedClaudePlugin();
    const env = { PATHRULE_HOME: join(home, ".pathrule"), HOME: home };
    const calls: string[] = [];
    const report = await runCliDoctor(env, home, { fetchImpl: serving(body(), calls) });
    expect(calls).toEqual([]);
    expect(report.checks.find((c) => c.name === "cli_version")?.detail).toContain(
      "not checked yet (run pathrule update to check now)",
    );
    expect(report.checks.find((c) => c.name === "update_checks")?.detail).toContain(
      "Automatic (update.policy automatic, the default)",
    );
    // What a check verified earlier is what doctor shows next.
    await runCliDoctor(env, home, { fetchImpl: serving(body()), interactive: true });
    const later = await runCliDoctor(env, home, { fetchImpl: serving(body(), calls) });
    expect(calls).toEqual([]);
    expect(later.checks.find((c) => c.name === "cli_version")?.detail).toContain(
      "99.0.0 is available",
    );
  });

  it("names the policy and the technical switch", async () => {
    const env = { PATHRULE_HOME: join(home, ".pathrule"), HOME: home };
    const notify = await runCliDoctor({ ...env, PATHRULE_UPDATE_POLICY: "manual" }, home, {
      fetchImpl: offline,
    });
    expect(notify.checks.find((c) => c.name === "update_checks")?.detail).toContain(
      "Notify only (update.policy notify)",
    );
    const off = await runCliDoctor({ ...env, PATHRULE_DISABLE_UPDATES: "1" }, home, {
      fetchImpl: offline,
    });
    expect(off.checks.find((c) => c.name === "update_checks")?.detail).toBe(
      "turned off on this machine (PATHRULE_DISABLE_UPDATES)",
    );
  });

  it("tells a person at a terminal about a plugin its host will not update by itself", async () => {
    seedClaudePlugin();
    const env = { PATHRULE_HOME: join(home, ".pathrule"), HOME: home };
    await fetchReleaseManifest({ env, fetchImpl: serving(body()), userAgent: "test" });
    expect((await pendingPluginNotice(env))?.lines).toEqual([
      "The Pathrule plugin 1.0.2 is available for Claude Code. You're using 1.0.0.",
      "Run: claude plugin marketplace update pathrule && claude plugin update pathrule@pathrule. It takes effect after /reload-plugins or in a new session.",
    ]);
    writeFileSync(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({
        pathrule: {
          source: { source: "github", repo: "pathrule/pathrule" },
          autoUpdate: true,
        },
      }),
    );
    expect(await pendingPluginNotice(env)).toBeNull();
  });
});
