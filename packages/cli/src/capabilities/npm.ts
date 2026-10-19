// SPDX-License-Identifier: Apache-2.0
/**
 * Running npm for a CLI update. The CLI does not resolve, fetch or check packages itself:
 * npm does, under the person's own npm configuration (registry, proxy, auth, cache).
 *
 * - **Which npm:** the one beside the Node running the CLI, started as `node npm-cli.js`, which needs
 *   no shell on any system. Without one, `npm` from the PATH.
 * - **Which settings:** the person's, except the ones that would change where or how this install
 *   lands. A CLI started by `npm exec` or an npm script inherits `npm_config_*` variables such as
 *   `npm_config_global`; those are dropped, and the update passes its own flags.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NpmResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunNpm = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<NpmResult>;

/** How to start npm: a program and the arguments that come before npm's own. */
export interface NpmLauncher {
  command: string;
  prefix: string[];
  shell: boolean;
}

export function locateNpm(execPath: string = process.execPath): NpmLauncher {
  const nodeDir = dirname(execPath);
  const candidates: string[] = [];
  // Unix layouts link bin/npm to lib/node_modules/npm/bin/npm-cli.js.
  try {
    const linked = realpathSync(join(nodeDir, "npm"));
    if (linked.endsWith("npm-cli.js")) candidates.push(linked);
  } catch {
    // No npm beside node.
  }
  candidates.push(
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), // Windows
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Unix
  );
  const cli = candidates.find((path) => existsSync(path));
  if (cli) return { command: execPath, prefix: [cli], shell: false };
  return { command: "npm", prefix: [], shell: process.platform === "win32" };
}

/** `npm_config_*` settings that decide where or how an install lands. */
const PLACEMENT_SETTINGS = new Set([
  "global",
  "location",
  "prefix",
  "dry_run",
  "package_lock_only",
  "omit",
  "include",
  "workspace",
  "workspaces",
  "include_workspace_root",
  "save",
  "save_dev",
  "save_prod",
  "save_optional",
  "save_peer",
  "save_exact",
  "legacy_peer_deps",
  "strict_peer_deps",
  "force",
  "ignore_scripts",
  "production",
  "only",
  "also",
  "install_links",
  "install_strategy",
  "global_style",
  "legacy_bundling",
]);

/** The person's environment, without the inherited settings that would move this install. */
export function npmEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^npm_config_(.+)$/i.exec(key);
    if (match && PLACEMENT_SETTINGS.has(match[1]!.toLowerCase().replace(/-/g, "_"))) continue;
    out[key] = value;
  }
  out.npm_config_update_notifier = "false";
  out.npm_config_fund = "false";
  out.npm_config_audit = "false";
  return out;
}

export const runNpm: RunNpm = (args, { cwd, env, timeoutMs }) => {
  const npm = locateNpm();
  const argv = [...npm.prefix, ...args];
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(npm.command, npm.shell ? argv.map(quoteForShell) : argv, {
        cwd,
        env: npmEnvironment(env),
        shell: npm.shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      done({ status: null, stdout, stderr: String(error), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => (stderr += `\n${String(error)}`));
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, timedOut });
    });
  });
};

function quoteForShell(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}
