// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { RunNpm } from "../capabilities/npm.js";
import {
  confirmInstall,
  detectInstallMethod,
  type InstallMethod,
  type RunProgram,
} from "./install-method.js";

const env = { PATHRULE_HOME: "/Users/ada/.pathrule" };
const winEnv = { PATHRULE_HOME: "C:\\Users\\Ada\\.pathrule" };

describe("detectInstallMethod", () => {
  const cases: Array<[NodeJS.Platform, string, InstallMethod, string | null]> = [
    // macOS
    ["darwin", "/opt/homebrew/lib/node_modules/@pathrule/cli/dist/index.js", "npm-global", "npm"],
    [
      "darwin",
      "/Users/ada/.nvm/versions/node/v22.11.0/lib/node_modules/@pathrule/cli/dist/index.js",
      "npm-global",
      "npm",
    ],
    ["darwin", "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js", "homebrew", "homebrew"],
    ["darwin", "/Users/ada/.npm/_npx/6a1f/node_modules/@pathrule/cli/dist/index.js", "npx", "npm"],
    [
      "darwin",
      "/Users/ada/Library/pnpm/global/5/node_modules/@pathrule/cli/dist/index.js",
      "pnpm-global",
      "npm",
    ],
    [
      "darwin",
      "/Users/ada/.volta/tools/image/packages/@pathrule/cli/lib/node_modules/@pathrule/cli/dist/index.js",
      "volta",
      "npm",
    ],
    [
      "darwin",
      "/Users/ada/.bun/install/global/node_modules/@pathrule/cli/dist/index.js",
      "bun-global",
      "npm",
    ],
    [
      "darwin",
      "/Users/ada/.vscode/extensions/pathrule.pathrule-vscode-0.8.0-darwin-arm64/dist/cli/dist/index.js",
      "vscode",
      null,
    ],
    [
      "darwin",
      "/Users/ada/.pathrule/runtime/1.0.0/node_modules/@pathrule/cli/dist/index.js",
      "agent-plugin",
      "npm",
    ],
    ["darwin", "/Users/ada/code/app/node_modules/@pathrule/cli/dist/index.js", "project", "npm"],
    ["darwin", "/Users/ada/src/pathrule/packages/cli/dist/index.js", "source", null],
    [
      "darwin",
      "/Users/ada/Downloads/pathrule-cli-1.0.0-node20-universal/dist/index.js",
      "standalone",
      "standalone",
    ],
    ["darwin", "/usr/local/bin/something-else.js", "unknown", "npm"],
    // Linux
    ["linux", "/usr/lib/node_modules/@pathrule/cli/dist/index.js", "npm-global", "npm"],
    [
      "linux",
      "/home/ada/.local/share/pnpm/global/5/node_modules/@pathrule/cli/dist/index.js",
      "pnpm-global",
      "npm",
    ],
    [
      "linux",
      "/home/ada/.config/yarn/global/node_modules/@pathrule/cli/dist/index.js",
      "yarn-global",
      "npm",
    ],
    [
      "linux",
      "/home/linuxbrew/.linuxbrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
      "homebrew",
      "homebrew",
    ],
    [
      "linux",
      "/home/ada/.vscode-server/extensions/pathrule.pathrule-vscode-0.8.0/dist/cli/dist/index.js",
      "vscode",
      null,
    ],
    // Paths a real pnpm 12 (global v11 layout) and Yarn 1 produced in a Linux container.
    [
      "linux",
      "/home/node/.local/share/pnpm/global/v11/620b5939c810b31d040951d523eb23c3f85e6314aa78a30a847a7e6eb2fb0d35/node_modules/@pathrule/cli/dist/index.js",
      "pnpm-global",
      "npm",
    ],
    [
      "linux",
      "/home/node/.local/share/pnpm/global/v11/14-18ddebfd9d292a3c-0/node_modules/.pnpm/@pathrule+cli@0.6.1/node_modules/@pathrule/cli/dist/index.js",
      "pnpm-global",
      "npm",
    ],
    [
      "linux",
      "/home/node/.npm-global/lib/node_modules/@pathrule/cli/dist/index.js",
      "npm-global",
      "npm",
    ],
    // Windows
    [
      "win32",
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@pathrule\\cli\\dist\\index.js",
      "npm-global",
      "npm",
    ],
    [
      "win32",
      "C:\\Program Files\\nodejs\\node_modules\\@pathrule\\cli\\dist\\index.js",
      "npm-global",
      "npm",
    ],
    [
      "win32",
      "C:\\Users\\Ada\\AppData\\Local\\npm-cache\\_npx\\1f2e\\node_modules\\@pathrule\\cli\\dist\\index.js",
      "npx",
      "npm",
    ],
    [
      "win32",
      "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Pathrule.CLI_x\\dist\\index.js",
      "winget",
      "winget",
    ],
    [
      "win32",
      "C:\\Users\\Ada\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@pathrule\\cli\\dist\\index.js",
      "pnpm-global",
      "npm",
    ],
    [
      "win32",
      "C:\\Users\\Ada\\.pathrule\\runtime\\1.0.0\\node_modules\\@pathrule\\cli\\dist\\index.js",
      "agent-plugin",
      "npm",
    ],
    [
      "win32",
      "C:\\Users\\Ada\\.vscode\\extensions\\pathrule.pathrule-vscode-0.8.0-win32-x64\\dist\\cli\\dist\\index.js",
      "vscode",
      null,
    ],
  ];
  for (const [platform, entry, method, distribution] of cases) {
    it(`${platform}: ${method} from ${entry}`, () => {
      const info = detectInstallMethod({
        entry,
        env: platform === "win32" ? winEnv : env,
        platform,
      });
      expect(info.method).toBe(method);
      expect(info.distribution).toBe(distribution);
      expect(info.confidence).toBe(method === "unknown" ? "none" : "path");
    });
  }

  it("knows nothing from no entry", () => {
    expect(detectInstallMethod({ entry: "", env }).method).toBe("unknown");
  });
});

describe("confirmInstall", () => {
  const npmAt =
    (prefix: string, status = 0): RunNpm =>
    async () => ({
      status,
      stdout: `${prefix}\n`,
      stderr: "",
      timedOut: false,
    });
  const noProgram: RunProgram = async () => {
    throw new Error("should not run");
  };
  const identity = (p: string) => p;

  it("confirms an npm global install npm itself places there", async () => {
    const info = detectInstallMethod({
      entry: "/usr/local/lib/node_modules/@pathrule/cli/dist/index.js",
      env,
      platform: "linux",
    });
    const confirmed = await confirmInstall(info, {
      env,
      platform: "linux",
      runNpm: npmAt("/usr/local"),
      runProgram: noProgram,
      cwd: "/",
      realpath: identity,
    });
    expect(confirmed.confidence).toBe("confirmed");
  });

  it("does not confirm a copy under another npm prefix (two Node installs)", async () => {
    const info = detectInstallMethod({
      entry: "/Users/ada/.nvm/versions/node/v20/lib/node_modules/@pathrule/cli/dist/index.js",
      env,
      platform: "darwin",
    });
    const confirmed = await confirmInstall(info, {
      env,
      platform: "darwin",
      runNpm: npmAt("/opt/homebrew"),
      runProgram: noProgram,
      cwd: "/",
      realpath: identity,
    });
    expect(confirmed.confidence).toBe("path");
  });

  it("confirms a Windows global install against npm's prefix, case-insensitively", async () => {
    const entry =
      "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@pathrule\\cli\\dist\\index.js";
    const info = detectInstallMethod({ entry, env: winEnv, platform: "win32" });
    const confirmed = await confirmInstall(info, {
      env: winEnv,
      platform: "win32",
      runNpm: npmAt("c:\\users\\ada\\appdata\\roaming\\npm"),
      runProgram: noProgram,
      cwd: "C:\\",
      realpath: identity,
    });
    expect(confirmed.confidence).toBe("confirmed");
  });

  it("asks Homebrew for a Cellar install, and trusts nothing when it fails", async () => {
    const info = detectInstallMethod({
      entry: "/opt/homebrew/Cellar/pathrule/1.0.0/libexec/dist/index.js",
      env,
      platform: "darwin",
    });
    const brew =
      (status: number, stdout: string): RunProgram =>
      async (command, args) => {
        expect([command, ...args]).toEqual(["brew", "list", "--versions", "pathrule"]);
        return { status, stdout, stderr: "" };
      };
    const deps = {
      env,
      platform: "darwin" as const,
      runNpm: npmAt("/x"),
      cwd: "/",
      realpath: identity,
    };
    expect(
      (await confirmInstall(info, { ...deps, runProgram: brew(0, "pathrule 1.0.0\n") })).confidence,
    ).toBe("confirmed");
    expect((await confirmInstall(info, { ...deps, runProgram: brew(1, "") })).confidence).toBe(
      "path",
    );
  });

  it("never confirms what it may not update", async () => {
    for (const entry of [
      "/Users/ada/.npm/_npx/6a1f/node_modules/@pathrule/cli/dist/index.js",
      "/Users/ada/.vscode/extensions/pathrule.pathrule-vscode-0.8.0/dist/cli/dist/index.js",
    ]) {
      const info = detectInstallMethod({ entry, env, platform: "darwin" });
      const confirmed = await confirmInstall(info, {
        env,
        runNpm: npmAt("/Users/ada/.npm/_npx/6a1f"),
        runProgram: noProgram,
        cwd: "/",
        realpath: identity,
      });
      expect(confirmed.confidence).toBe("path");
    }
  });
});
