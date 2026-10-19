// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUpdateState } from "@pathrule/core/release/update-state.js";
import {
  cliComponent,
  release,
  SAMPLE_SHA512,
  testManifest,
} from "@pathrule/core/release/__fixtures__/signed-manifest.js";
import type { ReleaseManifest } from "@pathrule/protocol/release-manifest.js";

import type { RunNpm } from "../capabilities/npm.js";
import { planCliUpdate, runCliUpdate, type CliUpdatePlan } from "./cli-update.js";
import { detectInstallMethod, type InstallMethod, type RunProgram } from "./install-method.js";

const GLOBAL = "/usr/local/lib/node_modules/@pathrule/cli/dist/index.js";

function manifest(
  extra: Partial<Parameters<typeof cliComponent>[1]> = {},
  integrity = true,
): ReleaseManifest {
  return testManifest({
    cli: cliComponent(
      {
        npm: {
          latest: release("1.0.1", {
            ...(integrity ? { integrity: { algorithm: "sha512", digest: SAMPLE_SHA512 } } : {}),
            release_notes_url: "https://pathrule.io/changelog#1.0.1",
          }),
        },
        homebrew: { latest: release("1.0.1") },
        standalone: {
          latest: release("1.0.1", {
            artifact_url:
              "https://app.pathrule.io/downloads/pathrule-cli-1.0.1-node20-universal.tar.gz",
            integrity: { algorithm: "sha256", digest: "a".repeat(64) },
          }),
        },
      },
      extra,
    ),
    cloud: { restart: "none", accepts: { cloud_api: { min: 1, max: 1 } }, channels: {} },
  });
}

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pathrule-cli-update-"));
  env = { PATHRULE_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function plan(
  entry: string,
  current = "1.0.0",
  m: ReleaseManifest | null = manifest(),
  platform: NodeJS.Platform = "linux",
): CliUpdatePlan {
  return planCliUpdate({
    manifest: m,
    install: detectInstallMethod({ entry, env, platform }),
    current,
    track: "latest",
  });
}

/** An npm that answers the commands an update runs and records them. */
function fakeNpm(
  options: {
    integrity?: string;
    install?: { status: number; stderr?: string };
    installed?: string;
  } = {},
) {
  const calls: string[][] = [];
  const runNpm: RunNpm = async (args) => {
    calls.push([...args]);
    if (args[0] === "prefix")
      return { status: 0, stdout: "/usr/local\n", stderr: "", timedOut: false };
    if (args[0] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify(options.integrity ?? `sha512-${SAMPLE_SHA512}`),
        stderr: "",
        timedOut: false,
      };
    }
    if (args[0] === "install") {
      return {
        status: options.install?.status ?? 0,
        stdout: "",
        stderr: options.install?.stderr ?? "",
        timedOut: false,
      };
    }
    throw new Error(`unexpected npm ${args.join(" ")}`);
  };
  return { calls, runNpm, readInstalledVersion: () => options.installed ?? "1.0.1" };
}

const deps = (
  npm: ReturnType<typeof fakeNpm>,
  extra: Partial<Parameters<typeof runCliUpdate>[1]> = {},
) => ({
  env,
  cwd: "/",
  platform: "linux" as const,
  runNpm: npm.runNpm,
  readInstalledVersion: npm.readInstalledVersion,
  realpath: (p: string) => p,
  ...extra,
});

describe("planning a CLI update", () => {
  const commands: Array<[InstallMethod, string, string | null, boolean]> = [
    ["npm-global", GLOBAL, "npm install -g @pathrule/cli@1.0.1", true],
    [
      "homebrew",
      "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
      "brew upgrade pathrule",
      true,
    ],
    [
      "pnpm-global",
      "/home/ada/.local/share/pnpm/global/5/node_modules/@pathrule/cli/dist/index.js",
      "pnpm add -g @pathrule/cli@1.0.1",
      false,
    ],
    [
      "npx",
      "/home/ada/.npm/_npx/1/node_modules/@pathrule/cli/dist/index.js",
      "npx @pathrule/cli@1.0.1",
      false,
    ],
    [
      "project",
      "/home/ada/app/node_modules/@pathrule/cli/dist/index.js",
      "npm install @pathrule/cli@1.0.1",
      false,
    ],
    ["standalone", "/home/ada/pathrule-cli-1.0.0-node20-universal/dist/index.js", null, false],
    [
      "vscode",
      "/home/ada/.vscode/extensions/pathrule.pathrule-vscode-0.8.0/dist/cli/dist/index.js",
      null,
      false,
    ],
  ];
  for (const [method, entry, command, runnable] of commands) {
    it(`${method}: ${command ?? "no command"}`, () => {
      const p = plan(entry);
      expect(p.install.method).toBe(method);
      expect(p.command).toBe(command);
      expect(p.runnable).toBe(runnable);
    });
  }

  it("tells npx users to name a version, since npx reuses its cached copy", () => {
    expect(
      plan("/home/ada/.npm/_npx/1/node_modules/@pathrule/cli/dist/index.js").guidance,
    ).toContain("npx @pathrule/cli@1.0.1");
  });

  it("points a standalone install at the verified download and its digest", () => {
    expect(plan("/home/ada/pathrule-cli-1.0.0-node20-universal/dist/index.js").guidance).toContain(
      `pathrule-cli-1.0.1-node20-universal.tar.gz and check its sha256 (${"a".repeat(64)})`,
    );
  });

  it("asks for nothing without a manifest, and reports Cloud's contract range", () => {
    expect(plan(GLOBAL, "1.0.0", null).assessment).toBeNull();
    const outdated = planCliUpdate({
      manifest: testManifest({
        cloud: { restart: "none", accepts: { cloud_api: { min: 2, max: 3 } }, channels: {} },
      }),
      install: detectInstallMethod({ entry: GLOBAL, env, platform: "linux" }),
      current: "1.0.0",
      track: "latest",
    });
    expect(outdated.cloud).toMatchObject({ ok: false, reason: "client_outdated" });
  });
});

describe("running a CLI update", () => {
  it("installs exactly the verified version with npm, after checking the registry's integrity", async () => {
    const npm = fakeNpm();
    const outcome = await runCliUpdate(plan(GLOBAL), deps(npm));
    expect(outcome).toMatchObject({
      ok: true,
      status: "updated",
      from: "1.0.0",
      to: "1.0.1",
      restart: "new-session",
    });
    expect(npm.calls).toEqual([
      ["prefix", "-g"],
      ["view", "@pathrule/cli@1.0.1", "dist.integrity", "--json"],
      ["install", "-g", "@pathrule/cli@1.0.1", "--no-fund", "--no-audit"],
      ["prefix", "-g"],
    ]);
    expect(readUpdateState(env).installed).toMatchObject({
      component: "cli",
      from: "1.0.0",
      to: "1.0.1",
      by: "command",
      announced: true,
    });
  });

  it("refuses when the registry's integrity is not the signed one", async () => {
    const npm = fakeNpm({ integrity: `sha512-${"Z".repeat(86)}==` });
    const outcome = await runCliUpdate(plan(GLOBAL), deps(npm));
    expect(outcome).toMatchObject({ ok: false, status: "integrity_mismatch" });
    expect(npm.calls.some((c) => c[0] === "install")).toBe(false);
    expect(readUpdateState(env).installed).toBeUndefined();
  });

  it("refuses without an npm integrity in the manifest", async () => {
    const npm = fakeNpm();
    const outcome = await runCliUpdate(plan(GLOBAL, "1.0.0", manifest({}, false)), deps(npm));
    expect(outcome).toMatchObject({
      ok: false,
      status: "integrity_missing",
      command: "npm install -g @pathrule/cli@1.0.1",
    });
  });

  it("names a permission error and hands over the command", async () => {
    const npm = fakeNpm({
      install: {
        status: 243,
        stderr:
          "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@pathrule",
      },
    });
    const outcome = await runCliUpdate(plan(GLOBAL), deps(npm));
    expect(outcome).toMatchObject({
      ok: false,
      status: "permission_denied",
      command: "npm install -g @pathrule/cli@1.0.1",
    });
    // The line that says what went wrong, not npm's pointer to its log file.
    expect((outcome as { detail: string }).detail).toBe(
      "npm error path /usr/local/lib/node_modules/@pathrule",
    );
  });

  it("reports a failed install, and one that left another version", async () => {
    expect(
      await runCliUpdate(
        plan(GLOBAL),
        deps(fakeNpm({ install: { status: 1, stderr: "npm error network ETIMEDOUT" } })),
      ),
    ).toMatchObject({
      ok: false,
      status: "failed",
      detail: "npm error network ETIMEDOUT",
    });
    expect(await runCliUpdate(plan(GLOBAL), deps(fakeNpm({ installed: "1.0.0" })))).toMatchObject({
      ok: false,
      status: "not_installed",
    });
  });

  it("does not touch a copy npm does not list as its own", async () => {
    const npm = fakeNpm();
    const otherPrefix: RunNpm = async (args) =>
      args[0] === "prefix"
        ? { status: 0, stdout: "/opt/other\n", stderr: "", timedOut: false }
        : npm.runNpm(args, { cwd: "/", env, timeoutMs: 1 });
    const outcome = await runCliUpdate(plan(GLOBAL), deps(npm, { runNpm: otherPrefix }));
    expect(outcome).toMatchObject({ ok: false, status: "not_confirmed" });
    expect(npm.calls.some((c) => c[0] === "install")).toBe(false);
  });

  it("names the running sessions that keep the old version, and stops none of them", async () => {
    const dir = join(home, "updates", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.ppid}-mcp.json`),
      JSON.stringify({
        pid: process.ppid,
        kind: "mcp",
        version: "1.0.0",
        started_at: "2026-10-13T08:00:00Z",
      }),
    );
    const outcome = await runCliUpdate(plan(GLOBAL), deps(fakeNpm()));
    expect(outcome).toMatchObject({
      ok: true,
      status: "updated",
      sessions: [{ pid: process.ppid, version: "1.0.0" }],
    });
  });

  it("upgrades a confirmed Homebrew install with brew", async () => {
    const ran: string[][] = [];
    const brew: RunProgram = async (command, args) => {
      ran.push([command, ...args]);
      return { status: 0, stdout: args[0] === "list" ? "pathrule 1.0.0\n" : "", stderr: "" };
    };
    const npm = fakeNpm();
    const outcome = await runCliUpdate(
      plan(
        "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
        "1.0.0",
        manifest(),
        "darwin",
      ),
      deps(npm, { runProgram: brew, platform: "darwin" }),
    );
    expect(outcome).toMatchObject({ ok: true, status: "updated", to: "1.0.1" });
    expect(ran).toEqual([
      ["brew", "list", "--versions", "pathrule"],
      ["brew", "upgrade", "pathrule"],
    ]);
  });

  it("does nothing when up to date, ahead, or managed elsewhere", async () => {
    expect(await runCliUpdate(plan(GLOBAL, "1.0.1"), deps(fakeNpm()))).toMatchObject({
      ok: true,
      status: "up_to_date",
    });
    expect(await runCliUpdate(plan(GLOBAL, "2.0.0"), deps(fakeNpm()))).toMatchObject({
      ok: true,
      status: "up_to_date",
    });
    expect(
      await runCliUpdate(
        plan("/home/ada/.vscode/extensions/pathrule.pathrule-vscode-0.8.0/dist/cli/dist/index.js"),
        deps(fakeNpm()),
      ),
    ).toMatchObject({ ok: true, status: "nothing_to_do" });
    expect(
      await runCliUpdate(
        plan("/home/ada/.npm/_npx/1/node_modules/@pathrule/cli/dist/index.js"),
        deps(fakeNpm()),
      ),
    ).toMatchObject({ ok: false, status: "not_runnable", command: "npx @pathrule/cli@1.0.1" });
  });
});
