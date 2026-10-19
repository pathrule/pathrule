// SPDX-License-Identifier: Apache-2.0
/**
 * The background update check. After an interactive command, when one is due, the CLI starts a copy
 * of itself as a detached process (`pathrule __update-check`) and exits without waiting for it: the
 * command is never slower for it, and an offline machine never sees an error. The copy fetches and
 * verifies the manifest into the update state; the next interactive command reads the notice from
 * there.
 *
 * Both policies check (`automatic`, the default, and `notify`). No check runs from CI, under
 * `NO_UPDATE_CHECK=1` or `PATHRULE_DISABLE_UPDATES=1`, from a CLI built from source (the same rule
 * as telemetry), or from anything but a person at a terminal.
 *
 * Under `automatic`, the copy also installs an available update where that is safe: npm confirms
 * the install is its own global one, the registry's integrity matches the signed manifest, and no
 * Pathrule MCP server or host is running (an MCP server of the old version could start a host of
 * the new one, and Windows cannot replace a loaded native module). While one runs, it tries again
 * every hour and the notice says the update waits for those sessions. Installs a package manager
 * owns (Homebrew, WinGet, pnpm, ...) are never changed: the notice names their command.
 */
import { spawn } from "node:child_process";

import {
  cachedReleaseManifest,
  fetchReleaseManifest,
  updateCheckDue,
} from "@pathrule/core/release/release-feed.js";
import { activeRuntimeSessions } from "@pathrule/core/release/runtime-sessions.js";
import {
  readUpdatePreference,
  readUpdateState,
  updateUpdateState,
  type UpdateState,
} from "@pathrule/core/release/update-state.js";

import { runNpm, type RunNpm } from "../capabilities/npm.js";
import { CLI_VERSION } from "../cli-version.js";
import {
  backgroundChecksAllowed,
  resolveUpdatePolicy,
  updatesDisabled,
  type UpdatePolicyState,
} from "../config.js";
import type { CliSelfCommand } from "../local/self-command.js";
import { planCliUpdate, runCliUpdate, type RunCliUpdateDeps } from "./cli-update.js";
import { detectInstallMethod, runningEntry, type InstallInfo } from "./install-method.js";

export const BACKGROUND_CHECK_COMMAND = "__update-check";

/** Whether background checks run here: see the module comment. The policy only decides installs. */
export function automaticChecksEnabled(input: {
  env: NodeJS.ProcessEnv;
  install: Pick<InstallInfo, "method">;
}): boolean {
  return backgroundChecksAllowed(input.env) && input.install.method !== "source";
}

/** An automatic install that waited for running sessions is tried again after this long. */
export const AUTO_RETRY_MS = 60 * 60 * 1000;

/** Whether the background copy should run now: a check is due, or a waiting install may retry. */
export function backgroundWorkDue(state: UpdateState, now: Date = new Date()): boolean {
  if (updateCheckDue(state, now)) return true;
  if (state.auto?.outcome !== "waiting_for_sessions") return false;
  const age = now.getTime() - Date.parse(state.auto.at);
  return !(age >= 0 && age < AUTO_RETRY_MS);
}

/**
 * Start the background check when one is due. Returns whether a process was started. Never throws
 * and never waits: the child is detached, its output discarded, and the parent does not keep it.
 */
export function startBackgroundUpdateCheck(input: {
  self: CliSelfCommand | null;
  env: NodeJS.ProcessEnv;
  now?: Date;
  spawnImpl?: typeof spawn;
}): boolean {
  if (!input.self) return false;
  const now = input.now ?? new Date();
  const state = readUpdateState(input.env);
  if (!backgroundWorkDue(state, now)) return false;
  // Claimed before the child starts, so a burst of commands starts one check, not one each.
  updateUpdateState(input.env, (s) =>
    updateCheckDue(s, now)
      ? { ...s, last_attempt_at: now.toISOString(), last_error: "pending" }
      : { ...s, auto: { ...s.auto!, at: now.toISOString() } },
  );
  try {
    const child = (input.spawnImpl ?? spawn)(
      input.self.command,
      [...input.self.args, BACKGROUND_CHECK_COMMAND],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...input.env, ...input.self.env, PATHRULE_BACKGROUND_UPDATE_CHECK: "1" },
      },
    );
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface BackgroundCheckDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  policy: UpdatePolicyState;
  install: InstallInfo;
  cwd: string;
  fetchImpl?: typeof fetch;
  runNpm?: RunNpm;
  now?: () => Date;
  /** Test seams of the install itself (`runCliUpdate`). */
  update?: Pick<RunCliUpdateDeps, "realpath" | "readInstalledVersion">;
}

export type BackgroundCheckOutcome =
  | "disabled"
  | "check_failed"
  | "checked"
  | "auto_skipped_sessions"
  | "auto_updated"
  | "auto_failed";

/** What `pathrule __update-check` does, in the detached process. */
export async function runBackgroundUpdateCheck(
  deps: BackgroundCheckDeps,
): Promise<BackgroundCheckOutcome> {
  return checkAndUpdateCli(deps);
}

async function checkAndUpdateCli(deps: BackgroundCheckDeps): Promise<BackgroundCheckOutcome> {
  const { env } = deps;
  if (!automaticChecksEnabled({ env, install: deps.install })) return "disabled";
  const now = deps.now ?? (() => new Date());
  const state = readUpdateState(env);
  let manifest;
  // "pending": the parent claimed this check before starting the copy.
  if (state.last_error === "pending" || updateCheckDue(state, now())) {
    const fetched = await fetchReleaseManifest({
      env,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      userAgent: `pathrule-cli/${deps.version}`,
    });
    if (!fetched.ok) return "check_failed";
    manifest = fetched.manifest;
  } else {
    // An install that waited for sessions: the manifest verified an hour ago is still the truth.
    manifest = cachedReleaseManifest(env, { now: now() })?.manifest;
    if (!manifest) return "check_failed";
  }
  if (deps.policy.value !== "automatic" || deps.install.method !== "npm-global") return "checked";

  const plan = planCliUpdate({
    manifest,
    install: deps.install,
    current: deps.version,
    track: env.PATHRULE_UPDATE_TRACK === "stable" ? "stable" : "latest",
  });
  const status = plan.assessment?.status;
  if (status !== "update_available" && status !== "update_required") {
    if (state.auto?.outcome === "waiting_for_sessions") {
      updateUpdateState(env, (s) => {
        const next = { ...s };
        delete next.auto;
        return next;
      });
    }
    return "checked";
  }
  const version = plan.assessment!.latest!.version;
  const at = now().toISOString();
  if (activeRuntimeSessions(env).length > 0) {
    updateUpdateState(env, (s) => ({
      ...s,
      auto: { at, outcome: "waiting_for_sessions", version },
    }));
    return "auto_skipped_sessions";
  }
  const outcome = await runCliUpdate(plan, {
    env,
    cwd: deps.cwd,
    runNpm: deps.runNpm ?? runNpm,
    by: "auto",
    ...deps.update,
  });
  updateUpdateState(env, (s) => ({ ...s, auto: { at, outcome: outcome.status, version } }));
  return outcome.ok && outcome.status === "updated" ? "auto_updated" : "auto_failed";
}

/**
 * `pathrule __update-check`, from `main` before any plugin loads. The parent passes the policy it
 * resolved (an account may store it); without it, the environment and this machine's preference.
 */
export async function backgroundCheckMain(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const policy = resolveUpdatePolicy(
    env,
    env.PATHRULE_UPDATE_POLICY_RESOLVED ?? readUpdatePreference(env),
  );
  await runBackgroundUpdateCheck({
    env,
    version: CLI_VERSION,
    policy,
    install: detectInstallMethod({ entry: runningEntry(), env }),
    cwd,
  });
}

/**
 * For a process that runs for hours (the host): refresh the verified manifest on disk when a check
 * is due (once a day), so the MCP servers and the next command answer from fresh data. In-process,
 * quiet, and its timers never keep the process alive. Returns the stop.
 */
export function startPeriodicUpdateChecks(input: {
  env: NodeJS.ProcessEnv;
  version: string;
  fetchImpl?: typeof fetch;
  firstDelayMs?: number;
  everyMs?: number;
}): () => void {
  const run = () => {
    if (updatesDisabled(input.env) || !updateCheckDue(readUpdateState(input.env))) return;
    void fetchReleaseManifest({
      env: input.env,
      fetchImpl: input.fetchImpl,
      userAgent: `pathrule-cli/${input.version}`,
    }).catch(() => {});
  };
  const first = setTimeout(run, input.firstDelayMs ?? 60_000);
  const every = setInterval(run, input.everyMs ?? 6 * 60 * 60 * 1000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
