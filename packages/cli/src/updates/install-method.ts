// SPDX-License-Identifier: Apache-2.0
/**
 * How this copy of the CLI was installed, and so who may update it. Read from where the running
 * entry lives on disk, never from the network.
 *
 * A path is evidence, not proof. Before `pathrule update` runs a package manager it asks that
 * package manager to confirm the install is its own (`confirmInstall`); without that confirmation
 * the CLI only shows the command. Installs that something else owns (the VS Code extension, an
 * agent plugin's runtime, a source checkout) are never updated from here.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";
import type { ReleaseDistributionId } from "@pathrule/protocol/release-manifest.js";

import type { RunNpm } from "../capabilities/npm.js";

export type InstallMethod =
  | "npm-global"
  | "pnpm-global"
  | "yarn-global"
  | "bun-global"
  | "volta"
  | "npx"
  | "project"
  | "homebrew"
  | "winget"
  | "standalone"
  | "vscode"
  | "agent-plugin"
  | "source"
  | "unknown";

export interface InstallInfo {
  method: InstallMethod;
  /** The distribution channel whose verified release applies to this install, or null. */
  distribution: ReleaseDistributionId | null;
  /** `path`: read from the install path. `confirmed`: its package manager said so. */
  confidence: "path" | "confirmed" | "none";
  /** The entry the method was read from (the real path of the running script). */
  entry: string;
}

const NPM_REGISTRY_METHODS = new Set<InstallMethod>([
  "npm-global",
  "pnpm-global",
  "yarn-global",
  "bun-global",
  "volta",
  "npx",
  "project",
  "agent-plugin",
  // Unknown installs are compared with npm, the channel every release ships on; they are told
  // about a release but never updated from here.
  "unknown",
]);

function distributionOf(method: InstallMethod): ReleaseDistributionId | null {
  if (NPM_REGISTRY_METHODS.has(method)) return "npm";
  if (method === "homebrew" || method === "winget" || method === "standalone") return method;
  return null;
}

/** Forward slashes, and lower case on Windows, so one set of patterns reads every platform. */
function normalize(path: string, platform: NodeJS.Platform): string {
  const slashed = path.replace(/\\/g, "/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** The real path of the running entry, or the given one when it does not resolve. */
export function runningEntry(argv1: string | undefined = process.argv[1]): string {
  if (!argv1) return "";
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

export function detectInstallMethod(input: {
  entry: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): InstallInfo {
  const platform = input.platform ?? process.platform;
  const path = normalize(input.entry, platform);
  const home = normalize(pathruleHome(input.env), platform).replace(/\/$/, "");
  const result = (method: InstallMethod): InstallInfo => ({
    method,
    distribution: distributionOf(method),
    confidence: method === "unknown" ? "none" : "path",
    entry: input.entry,
  });
  const has = (pattern: RegExp) => pattern.test(path);

  if (!path) return result("unknown");
  // Owned by something else: never updated from here.
  if (home && path.startsWith(`${home}/runtime/`)) return result("agent-plugin");
  if (has(/\/extensions\/pathrule\.pathrule-vscode-\d/i)) return result("vscode");
  if (has(/\/packages\/cli(?:-official)?\/(?:dist|src)\//) && !has(/\/node_modules\//))
    return result("source");
  // Package managers, most specific first: their trees also contain node_modules.
  if (has(/\/_npx\//)) return result("npx");
  // A formula's files live in its Cellar; npm under Homebrew's Node is still npm (lib/node_modules).
  if (has(/\/cellar\/pathrule\//i)) return result("homebrew");
  if (has(/\/winget\/packages\//i)) return result("winget");
  if (has(/\/\.volta\//)) return result("volta");
  if (has(/\/pnpm\/global\//) || has(/\/\.?pnpm-global\//)) return result("pnpm-global");
  if (has(/\/\.config\/yarn\/global\//) || has(/\/yarn\/data\/global\//i))
    return result("yarn-global");
  if (has(/\/\.bun\/install\/global\//)) return result("bun-global");
  if (
    has(/\/lib\/node_modules\/@pathrule\/cli\//) ||
    has(/\/(?:npm|nodejs)\/node_modules\/@pathrule\/cli\//)
  ) {
    return result("npm-global");
  }
  if (has(/\/node_modules\/@pathrule\/cli\//)) return result("project");
  if (has(/\/pathrule-cli-\d+\.\d+\.\d+[^/]*\//)) return result("standalone");
  return result("unknown");
}

/** Runs a program and reports how it ended. Injected so tests never run a package manager. */
export type RunProgram = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

/** Where npm installs a global package, for its `npm prefix -g`. */
export function npmGlobalPackageDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? join(prefix, "node_modules", "@pathrule", "cli")
    : join(prefix, "lib", "node_modules", "@pathrule", "cli");
}

/**
 * Ask the package manager whether this install is its own. Only npm and Homebrew are asked: they
 * are the two `pathrule update` may run. Anything else stays at `path` confidence.
 */
export async function confirmInstall(
  info: InstallInfo,
  deps: {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    runNpm: RunNpm;
    runProgram: RunProgram;
    cwd: string;
    realpath?: (path: string) => string;
  },
): Promise<InstallInfo> {
  const platform = deps.platform ?? process.platform;
  const real = deps.realpath ?? ((p: string) => realpathSync(p));
  try {
    if (info.method === "npm-global") {
      const out = await deps.runNpm(["prefix", "-g"], {
        cwd: deps.cwd,
        env: deps.env,
        timeoutMs: 15_000,
      });
      const prefix = out.stdout.trim();
      if (out.status !== 0 || !prefix) return info;
      const packageDir = normalize(real(npmGlobalPackageDir(prefix, platform)), platform);
      // Both sides as real paths: /var and /private/var, or a symlinked prefix, are one place.
      let entry = info.entry;
      try {
        entry = real(info.entry);
      } catch {
        // An entry that does not resolve is compared as given.
      }
      return normalize(entry, platform).startsWith(`${packageDir}/`)
        ? { ...info, confidence: "confirmed" }
        : info;
    }
    if (info.method === "homebrew") {
      const out = await deps.runProgram("brew", ["list", "--versions", "pathrule"], {
        env: deps.env,
        timeoutMs: 15_000,
      });
      return out.status === 0 && /^pathrule\s/m.test(out.stdout)
        ? { ...info, confidence: "confirmed" }
        : info;
    }
  } catch {
    // A package manager that does not answer confirms nothing.
  }
  return info;
}

/**
 * The version of `@pathrule/cli` installed in a package directory now, which a long-running process
 * compares with the version it started as. Null when the directory holds something else.
 */
export function installedCliVersion(packageDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return manifest.name === "@pathrule/cli" && typeof manifest.version === "string"
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}
