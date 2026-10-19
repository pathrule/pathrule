// SPDX-License-Identifier: Apache-2.0
/**
 * Updating the CLI itself: what the verified manifest offers this install's channel, who installs
 * it, and, for the two package managers the CLI may drive (npm, Homebrew), installing it.
 *
 * - **Exact version, verified first.** npm is asked for the version the manifest names
 *   (`@pathrule/cli@1.0.1`, never `@latest`), and only after the registry's integrity for that
 *   version matches the one the signed manifest carries. npm then checks the tarball against it.
 * - **Never behind the person's back** unless they chose `update.policy auto`, and even then only
 *   for a confirmed npm install with no Pathrule session running (./background.ts).
 * - **Running sessions keep running.** Nothing is stopped or restarted. An agent session's MCP
 *   server keeps the version it started with; the result says so.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  activeRuntimeSessions,
  type RuntimeSessionLease,
} from "@pathrule/core/release/runtime-sessions.js";
import { updateUpdateState } from "@pathrule/core/release/update-state.js";
import {
  assessComponent,
  assessServiceContracts,
  type ComponentAssessment,
  type ContractAssessment,
  type ReleaseManifest,
  type ReleaseTrack,
} from "@pathrule/protocol/release-manifest.js";
import { PATHRULE_CONTRACTS } from "@pathrule/protocol/compatibility.js";

import type { RunNpm } from "../capabilities/npm.js";
import {
  confirmInstall,
  npmGlobalPackageDir,
  type InstallInfo,
  type RunProgram,
} from "./install-method.js";

export const CLI_NPM_PACKAGE = "@pathrule/cli";

/** Who installs an update of this copy. */
export type UpdateOwner =
  | "package-manager"
  | "editor"
  | "agent-plugin"
  | "download"
  | "source"
  | "unknown";

export interface CliUpdatePlan {
  current: string;
  install: InstallInfo;
  track: ReleaseTrack;
  /** Null when no verified manifest is available. */
  assessment: ComponentAssessment | null;
  /** Whether Pathrule Cloud (the service) still accepts this client's contracts. */
  cloud: ContractAssessment;
  owner: UpdateOwner;
  /** The command that installs the offered version; null when no command does. */
  command: string | null;
  /** `pathrule update` may run `command` itself (after confirming the install). */
  runnable: boolean;
  /** One sentence for an install something else updates. */
  guidance: string | null;
}

/** Whether there is anything to tell the person. */
export function planNeedsAction(plan: CliUpdatePlan): boolean {
  const status = plan.assessment?.status;
  return status === "update_available" || status === "update_required" || plan.cloud.ok === false;
}

export function planCliUpdate(input: {
  manifest: ReleaseManifest | null;
  install: InstallInfo;
  current: string;
  track: ReleaseTrack;
}): CliUpdatePlan {
  const { manifest, install, current, track } = input;
  const distribution = install.distribution;
  const assessment =
    manifest && distribution
      ? assessComponent(manifest, {
          component: "cli",
          distribution,
          track,
          installedVersion: current,
        })
      : null;
  const cloud: ContractAssessment = manifest
    ? assessServiceContracts(manifest, "cloud", PATHRULE_CONTRACTS)
    : { ok: true };
  const version = assessment?.latest?.version ?? "latest";
  const pkg = `${CLI_NPM_PACKAGE}@${version}`;
  const base = { current, install, track, assessment, cloud };
  switch (install.method) {
    case "npm-global":
      return {
        ...base,
        owner: "package-manager",
        command: `npm install -g ${pkg}`,
        runnable: true,
        guidance: null,
      };
    case "homebrew":
      return {
        ...base,
        owner: "package-manager",
        command: "brew upgrade pathrule",
        runnable: true,
        guidance: null,
      };
    case "pnpm-global":
      return {
        ...base,
        owner: "package-manager",
        command: `pnpm add -g ${pkg}`,
        runnable: false,
        guidance: null,
      };
    case "yarn-global":
      return {
        ...base,
        owner: "package-manager",
        command: `yarn global add ${pkg}`,
        runnable: false,
        guidance: null,
      };
    case "bun-global":
      return {
        ...base,
        owner: "package-manager",
        command: `bun add -g ${pkg}`,
        runnable: false,
        guidance: null,
      };
    case "volta":
      return {
        ...base,
        owner: "package-manager",
        command: `volta install ${pkg}`,
        runnable: false,
        guidance: null,
      };
    case "winget":
      return {
        ...base,
        owner: "package-manager",
        command: "winget upgrade pathrule",
        runnable: false,
        guidance: null,
      };
    case "project":
      return {
        ...base,
        owner: "package-manager",
        command: `npm install ${pkg}`,
        runnable: false,
        guidance: "This CLI is a dependency of the current project; update it there.",
      };
    case "npx":
      return {
        ...base,
        owner: "package-manager",
        command: `npx ${pkg}`,
        runnable: false,
        guidance: `npx keeps reusing the copy in its cache unless you name a version: use npx ${pkg}.`,
      };
    case "standalone": {
      const artifact = assessment?.latest?.artifact_url;
      const digest = assessment?.latest?.integrity;
      return {
        ...base,
        owner: "download",
        command: null,
        runnable: false,
        guidance: artifact
          ? `Download ${artifact}${digest ? ` and check its ${digest.algorithm} (${digest.digest})` : ""}.`
          : "Download the new release from pathrule.io.",
      };
    }
    case "vscode":
      return {
        ...base,
        owner: "editor",
        command: null,
        runnable: false,
        guidance: "This CLI ships inside the Pathrule extension; your editor updates it.",
      };
    case "agent-plugin":
      return {
        ...base,
        owner: "agent-plugin",
        command: null,
        runnable: false,
        guidance:
          "This runtime belongs to the Pathrule plugin of your AI agent; update the plugin and its setup installs the matching runtime.",
      };
    case "source":
      return {
        ...base,
        owner: "source",
        command: null,
        runnable: false,
        guidance: "This CLI was built from source; pull and rebuild it.",
      };
    default:
      return {
        ...base,
        owner: "unknown",
        command: `npm install -g ${pkg}`,
        runnable: false,
        guidance: `Pathrule could not tell how this copy was installed; update it with the tool you installed it with (with npm: npm install -g ${pkg}).`,
      };
  }
}

export type CliUpdateOutcome =
  | {
      ok: true;
      status: "updated";
      from: string;
      to: string;
      restart: ComponentAssessment["restart"];
      /** Sessions that keep running the previous version until they restart. */
      sessions: RuntimeSessionLease[];
    }
  | { ok: true; status: "up_to_date" | "nothing_to_do"; detail: string }
  | {
      ok: false;
      status:
        | "not_runnable"
        | "not_confirmed"
        | "integrity_missing"
        | "integrity_mismatch"
        | "permission_denied"
        | "failed"
        | "not_installed";
      detail: string;
      command: string | null;
    };

export interface RunCliUpdateDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  runNpm: RunNpm;
  runProgram?: RunProgram;
  realpath?: (path: string) => string;
  /** Reads the installed version back after npm ran. */
  readInstalledVersion?: (packageDir: string) => string | null;
  by?: "command" | "auto";
}

const PERMISSION = /\b(EACCES|EPERM)\b|permission denied|operation not permitted/i;

function readVersion(packageDir: string): string | null {
  try {
    return (
      (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string })
        .version ?? null
    );
  } catch {
    return null;
  }
}

/** Install the version a plan offers, with the install's own package manager. */
export async function runCliUpdate(
  plan: CliUpdatePlan,
  deps: RunCliUpdateDeps,
): Promise<CliUpdateOutcome> {
  const status = plan.assessment?.status;
  if (!plan.assessment || !plan.assessment.latest) {
    return {
      ok: true,
      status: "nothing_to_do",
      detail: "no verified release is known for this install",
    };
  }
  if (status !== "update_available" && status !== "update_required") {
    return { ok: true, status: "up_to_date", detail: `Pathrule ${plan.current} is up to date` };
  }
  if (!plan.runnable) {
    return {
      ok: false,
      status: "not_runnable",
      detail: plan.guidance ?? "This install is updated by its package manager.",
      command: plan.command,
    };
  }
  const runProgram = deps.runProgram ?? defaultRunProgram;
  const platform = deps.platform ?? process.platform;
  const confirmed = await confirmInstall(plan.install, {
    env: deps.env,
    platform,
    runNpm: deps.runNpm,
    runProgram,
    cwd: deps.cwd,
    realpath: deps.realpath,
  });
  if (confirmed.confidence !== "confirmed") {
    return {
      ok: false,
      status: "not_confirmed",
      detail: `${plan.install.method === "homebrew" ? "Homebrew" : "npm"} does not list this copy as its own, so Pathrule will not update it.`,
      command: plan.command,
    };
  }

  const target = plan.assessment.latest.version;
  const sessions = activeRuntimeSessions(deps.env);
  const done = (to: string): CliUpdateOutcome => {
    updateUpdateState(deps.env, (s) => ({
      ...s,
      // `pathrule update` says it itself; an automatic install is announced by the next command.
      installed: {
        component: "cli",
        from: plan.current,
        to,
        at: new Date().toISOString(),
        by: deps.by ?? "command",
        announced: (deps.by ?? "command") === "command",
      },
    }));
    return {
      ok: true,
      status: "updated",
      from: plan.current,
      to,
      restart: plan.assessment!.restart,
      sessions,
    };
  };

  if (plan.install.method === "homebrew") {
    const out = await runProgram("brew", ["upgrade", "pathrule"], {
      env: deps.env,
      timeoutMs: 10 * 60_000,
    });
    if (out.status !== 0) {
      return PERMISSION.test(out.stderr)
        ? {
            ok: false,
            status: "permission_denied",
            detail: lastLine(out.stderr),
            command: plan.command,
          }
        : {
            ok: false,
            status: "failed",
            detail: lastLine(out.stderr) || "brew upgrade failed",
            command: plan.command,
          };
    }
    return done(target);
  }

  // npm: the registry's integrity for exactly this version must be the one the manifest signed.
  const expected = plan.assessment.latest.integrity;
  if (!expected || expected.algorithm !== "sha512") {
    return {
      ok: false,
      status: "integrity_missing",
      detail: "the release manifest carries no npm integrity for this version",
      command: plan.command,
    };
  }
  const spec = `${CLI_NPM_PACKAGE}@${target}`;
  const view = await deps.runNpm(["view", spec, "dist.integrity", "--json"], {
    cwd: deps.cwd,
    env: deps.env,
    timeoutMs: 60_000,
  });
  let registryIntegrity: unknown = null;
  try {
    registryIntegrity = JSON.parse(view.stdout);
  } catch {
    registryIntegrity = view.stdout.trim();
  }
  if (view.status !== 0) {
    return {
      ok: false,
      status: "failed",
      detail: lastLine(view.stderr) || "npm could not read the registry",
      command: plan.command,
    };
  }
  if (registryIntegrity !== `sha512-${expected.digest}`) {
    return {
      ok: false,
      status: "integrity_mismatch",
      detail: `the registry's integrity for ${spec} is not the one the signed release manifest names`,
      command: null,
    };
  }
  const install = await deps.runNpm(["install", "-g", spec, "--no-fund", "--no-audit"], {
    cwd: deps.cwd,
    env: deps.env,
    timeoutMs: 10 * 60_000,
  });
  if (install.status !== 0) {
    const detail =
      lastLine(install.stderr) || (install.timedOut ? "npm timed out" : "npm install failed");
    return PERMISSION.test(install.stderr)
      ? { ok: false, status: "permission_denied", detail, command: plan.command }
      : { ok: false, status: "failed", detail, command: plan.command };
  }
  const prefix = (
    await deps.runNpm(["prefix", "-g"], { cwd: deps.cwd, env: deps.env, timeoutMs: 15_000 })
  ).stdout.trim();
  const installed = (deps.readInstalledVersion ?? readVersion)(
    npmGlobalPackageDir(prefix, platform),
  );
  if (installed !== target) {
    return {
      ok: false,
      status: "not_installed",
      detail: `npm finished, but ${CLI_NPM_PACKAGE} is ${installed ?? "missing"} instead of ${target}`,
      command: plan.command,
    };
  }
  return done(target);
}

/** The line of a package manager's error output that says what went wrong. */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^npm (?:warn|notice)/i.test(line) &&
        !/complete log of this run/i.test(line) &&
        !/^npm error (?:code|errno|syscall)\b/i.test(line),
    );
  const telling =
    lines.find((line) => PERMISSION.test(line)) ??
    lines.find((line) => /^npm error\b/i.test(line)) ??
    lines.pop() ??
    "";
  return telling.slice(0, 300);
}

/** Runs a program without a shell, with a deadline. */
export const defaultRunProgram: RunProgram = (command, args, { env, timeoutMs }) =>
  new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, [...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      done({ status: null, stdout, stderr: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ status: null, stdout, stderr: `${stderr}\n${String(error)}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
