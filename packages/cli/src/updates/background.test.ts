// SPDX-License-Identifier: Apache-2.0
import type { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cliComponent,
  offline,
  release,
  SAMPLE_SHA512,
  serving,
  signedBody,
  testManifest,
  trustTestReleaseKey,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import { readUpdateState } from "@pathrule/core/release/update-state.js";

import type { RunNpm } from "../capabilities/npm.js";
import { resolveUpdatePolicy } from "../config.js";
import { pendingCliUpdateNotice } from "../update-check.js";
import {
  automaticChecksEnabled,
  backgroundWorkDue,
  runBackgroundUpdateCheck,
  startBackgroundUpdateCheck,
  startPeriodicUpdateChecks,
} from "./background.js";
import { detectInstallMethod } from "./install-method.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const GLOBAL = "/usr/local/lib/node_modules/@pathrule/cli/dist/index.js";

let untrust: () => void;
beforeAll(() => {
  untrust = trustTestReleaseKey();
});
afterAll(() => untrust());

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-bg-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe("who gets background checks", () => {
  const installed = { method: "npm-global" as const };

  it("every released install, under either policy (the policy only decides installs)", () => {
    expect(automaticChecksEnabled({ env, install: installed })).toBe(true);
    expect(automaticChecksEnabled({ env, install: { method: "homebrew" } })).toBe(true);
    expect(automaticChecksEnabled({ env, install: { method: "unknown" } })).toBe(true);
  });

  it("never a source build, CI, NO_UPDATE_CHECK or the technical switch", () => {
    expect(automaticChecksEnabled({ env, install: { method: "source" } })).toBe(false);
    expect(automaticChecksEnabled({ env: { CI: "true" }, install: installed })).toBe(false);
    expect(automaticChecksEnabled({ env: { NO_UPDATE_CHECK: "1" }, install: installed })).toBe(
      false,
    );
    expect(
      automaticChecksEnabled({ env: { PATHRULE_DISABLE_UPDATES: "1" }, install: installed }),
    ).toBe(false);
  });
});

describe("the update policy", () => {
  it("is automatic by default, and only automatic or notify", () => {
    expect(resolveUpdatePolicy({})).toMatchObject({ value: "automatic", source: "default" });
    expect(resolveUpdatePolicy({}, "notify")).toMatchObject({ value: "notify", source: "config" });
    expect(resolveUpdatePolicy({ PATHRULE_UPDATE_POLICY: "automatic" }, "notify")).toMatchObject({
      value: "automatic",
      source: "env",
    });
  });

  it("reads an earlier CLI's values as today's: manual is notify, auto is automatic", () => {
    expect(resolveUpdatePolicy({}, "manual").value).toBe("notify");
    expect(resolveUpdatePolicy({}, "auto").value).toBe("automatic");
    expect(resolveUpdatePolicy({ PATHRULE_UPDATE_POLICY: "MANUAL" }).value).toBe("notify");
    expect(resolveUpdatePolicy({}, "off")).toMatchObject({ value: "automatic", source: "default" });
  });
});

describe("starting the background check", () => {
  function fakeSpawn(started: Array<{ args: readonly string[]; options: any }>): typeof spawn {
    return ((_command: string, args: readonly string[], options: any) => {
      started.push({ args, options });
      return { on: () => undefined, unref: () => undefined } as any;
    }) as unknown as typeof spawn;
  }

  it("starts one detached, silent copy, and not again while it is pending", () => {
    const started: Array<{ args: readonly string[]; options: any }> = [];
    const self = { command: "/usr/bin/node", args: [GLOBAL] };
    expect(startBackgroundUpdateCheck({ self, env, now: NOW, spawnImpl: fakeSpawn(started) })).toBe(
      true,
    );
    expect(startBackgroundUpdateCheck({ self, env, now: NOW, spawnImpl: fakeSpawn(started) })).toBe(
      false,
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.args).toEqual([GLOBAL, "__update-check"]);
    expect(started[0]!.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("starts nothing without a way to run itself (a library use, a test)", () => {
    const started: Array<{ args: readonly string[]; options: any }> = [];
    expect(
      startBackgroundUpdateCheck({ self: null, env, now: NOW, spawnImpl: fakeSpawn(started) }),
    ).toBe(false);
    expect(started).toHaveLength(0);
  });
});

describe("the background check itself", () => {
  const body = signedBody(
    testManifest({
      cli: cliComponent({
        npm: {
          latest: release("1.0.1", { integrity: { algorithm: "sha512", digest: SAMPLE_SHA512 } }),
        },
      }),
    }),
  );
  const install = () => detectInstallMethod({ entry: GLOBAL, env, platform: "linux" });
  const npmCalls: string[][] = [];
  const npm: RunNpm = async (args) => {
    npmCalls.push([...args]);
    if (args[0] === "prefix")
      return { status: 0, stdout: "/usr/local\n", stderr: "", timedOut: false };
    if (args[0] === "view")
      return {
        status: 0,
        stdout: JSON.stringify(`sha512-${SAMPLE_SHA512}`),
        stderr: "",
        timedOut: false,
      };
    return { status: 0, stdout: "", stderr: "", timedOut: false };
  };
  const seams = { realpath: (p: string) => p, readInstalledVersion: () => "1.0.1" };
  const sessionRunning = () => {
    const dir = join(home, "updates", "sessions");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${process.ppid}-mcp.json`);
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.ppid,
        kind: "mcp",
        version: "1.0.0",
        started_at: NOW.toISOString(),
      }),
    );
    return () => rmSync(path, { force: true });
  };
  const run = (policy: "automatic" | "notify" | "manual", extra: Record<string, unknown> = {}) =>
    runBackgroundUpdateCheck({
      env,
      version: "1.0.0",
      policy: resolveUpdatePolicy({}, policy),
      install: install(),
      cwd: "/",
      fetchImpl: serving(body),
      runNpm: npm,
      now: () => NOW,
      update: seams,
      ...extra,
    });
  beforeEach(() => {
    npmCalls.length = 0;
  });

  it("under notify (and the old manual), checks and installs nothing", async () => {
    expect(await run("notify")).toBe("checked");
    expect(readUpdateState(env).highest_sequence).toBe(1);
    expect(npmCalls).toEqual([]);
    expect(await run("manual", { now: () => new Date(NOW.getTime() + 25 * 3_600_000) })).toBe(
      "checked",
    );
    expect(npmCalls).toEqual([]);
  });

  // The fixture is a POSIX global npm install (/usr/local/lib/node_modules); Windows lays it out elsewhere.
  it.skipIf(process.platform === "win32")("under automatic, installs a confirmed npm global update and announces it once", async () => {
    expect(await run("automatic")).toBe("auto_updated");
    expect(npmCalls.map((c) => c[0])).toEqual(["prefix", "view", "install", "prefix"]);
    expect(readUpdateState(env).installed).toMatchObject({
      to: "1.0.1",
      by: "auto",
      announced: false,
    });
    const notice = pendingCliUpdateNotice("1.0.1", env, {
      now: NOW,
      policy: "automatic",
      install: install(),
    });
    expect(notice?.lines).toEqual([
      "Pathrule has been updated to 1.0.1. Restart your session to activate the new version.",
    ]);
  });

  it("is quiet offline, and keeps the running version", async () => {
    expect(await run("automatic", { fetchImpl: offline })).toBe("check_failed");
    expect(readUpdateState(env).last_error).toBe("offline");
    expect(npmCalls).toEqual([]);
  });

  // The fixture is a POSIX global npm install (/usr/local/lib/node_modules); Windows lays it out elsewhere.
  it.skipIf(process.platform === "win32")("under automatic, waits while a Pathrule session runs, says so, and tries again an hour later", async () => {
    const end = sessionRunning();
    expect(await run("automatic")).toBe("auto_skipped_sessions");
    expect(npmCalls.some((c) => c[0] === "install")).toBe(false);
    expect(readUpdateState(env).auto).toMatchObject({
      outcome: "waiting_for_sessions",
      version: "1.0.1",
    });
    expect(
      pendingCliUpdateNotice("1.0.0", env, { now: NOW, policy: "automatic", install: install() })
        ?.lines[0],
    ).toBe(
      "Pathrule 1.0.1 is available. It installs automatically once no Pathrule session is running.",
    );
    // Not again within the hour; after it, the retry needs no new check: the verified copy answers.
    expect(backgroundWorkDue(readUpdateState(env), new Date(NOW.getTime() + 10 * 60_000))).toBe(
      false,
    );
    const later = new Date(NOW.getTime() + 61 * 60_000);
    expect(backgroundWorkDue(readUpdateState(env), later)).toBe(true);
    end();
    const calls: string[] = [];
    expect(await run("automatic", { now: () => later, fetchImpl: serving(body, calls) })).toBe(
      "auto_updated",
    );
    expect(calls).toEqual([]);
  });

  it("under automatic, never installs over a copy npm does not confirm as its own, and says so", async () => {
    const outcome = await run("automatic", {
      // npm's global folder is elsewhere: the running copy is not npm's to replace.
      runNpm: async (args: readonly string[]) =>
        args[0] === "prefix"
          ? { status: 0, stdout: "/somewhere/else\n", stderr: "", timedOut: false }
          : npm(args, { cwd: "/", env, timeoutMs: 1 }),
    });
    expect(outcome).toBe("auto_failed");
    expect(npmCalls.some((c) => c[0] === "install")).toBe(false);
    expect(readUpdateState(env).auto).toMatchObject({ outcome: "not_confirmed" });
    expect(
      pendingCliUpdateNotice("1.0.0", env, { now: NOW, policy: "automatic", install: install() })
        ?.lines,
    ).toEqual([
      "Pathrule 1.0.1 could not be installed automatically: npm does not list this copy as its own. 1.0.0 keeps running.",
      "Run: pathrule update",
    ]);
  });

  it("leaves a package manager's install to it, under automatic too", async () => {
    const brew = detectInstallMethod({
      entry: "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
      env,
      platform: "darwin",
    });
    const brewBody = signedBody(
      testManifest({ cli: cliComponent({ homebrew: { latest: release("1.0.1") } }) }),
    );
    expect(await run("automatic", { install: brew, fetchImpl: serving(brewBody) })).toBe("checked");
    expect(npmCalls).toEqual([]);
    expect(
      pendingCliUpdateNotice("1.0.0", env, { now: NOW, policy: "automatic", install: brew })?.lines,
    ).toEqual([
      "Pathrule 1.0.1 is available. You're using 1.0.0.",
      "Your installation is managed by Homebrew. Run: brew upgrade pathrule",
    ]);
  });

  it("does nothing with updates disabled, and nothing from a source build", async () => {
    const calls: string[] = [];
    expect(
      await run("automatic", {
        env: { ...env, PATHRULE_DISABLE_UPDATES: "1" },
        fetchImpl: serving(body, calls),
      }),
    ).toBe("disabled");
    expect(
      await run("automatic", {
        install: detectInstallMethod({ entry: "/src/pathrule/packages/cli/dist/index.js", env }),
        fetchImpl: serving(body, calls),
      }),
    ).toBe("disabled");
    expect(calls).toEqual([]);
  });
});

describe("periodic checks in a long-running process", () => {
  it("refreshes the manifest when due, at most once a day, and stops", async () => {
    const calls: string[] = [];
    const body = signedBody(
      testManifest({ cli: cliComponent({ npm: { latest: release("1.0.1") } }) }),
    );
    const stop = startPeriodicUpdateChecks({
      env,
      version: "1.0.0",
      fetchImpl: serving(body, calls),
      firstDelayMs: 1,
      everyMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    // Many ticks, one request: the first success makes the next check due only a day later.
    expect(calls).toHaveLength(1);
    expect(readUpdateState(env).highest_sequence).toBe(1);
  });
});
