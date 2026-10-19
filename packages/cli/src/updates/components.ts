// SPDX-License-Identifier: Apache-2.0
/**
 * Every installed Pathrule component, as `pathrule doctor` reports it: the CLI (and its MCP
 * server), Pathrule Cloud's contract range, running sessions that still hold an older version and
 * the agent plugins Claude Code and Codex installed. Each row says what is installed, what its own
 * channel verifiably published, who updates it and what restart it needs.
 *
 * Read from the signed release manifest (checked now, or the last verified copy), the hosts' own
 * plugin state and this machine's files. Nothing here installs, edits a host's files or stops a
 * process.
 */
import {
  activeRuntimeSessions,
  type RuntimeSessionLease,
} from "@pathrule/core/release/runtime-sessions.js";
import {
  pluginActivation,
  pluginUpdateCommands,
  readClaudeCodePluginState,
  readCodexPluginState,
  type HostPluginState,
} from "@pathrule/integrations/native/host-plugin-state.js";
import { readRuntimeManifest } from "@pathrule/integrations/native/runtime-manifest-io.js";
import { LAUNCHER_CONTRACT } from "@pathrule/protocol/runtime-manifest.js";
import {
  channelReleaseOf,
  compareVersions,
  type ReleaseManifest,
} from "@pathrule/protocol/release-manifest.js";

import type { CliDoctorCheck } from "../doctor.js";
import { getUpdatePolicy } from "../config.js";
import {
  checkCliUpdate,
  nextStep,
  thisInstall,
  updatesDisabled,
  type CliUpdateCheckResult,
} from "../update-check.js";
import { updateCheckDue } from "@pathrule/core/release/release-feed.js";
import { readUpdateState } from "@pathrule/core/release/update-state.js";
import { automaticChecksEnabled } from "./background.js";
import type { CliUpdatePlan } from "./cli-update.js";

export interface UpdatesReport {
  cli: CliUpdateCheckResult;
  policy: "automatic" | "notify";
  /** Whether background checks run for this install. */
  automatic_checks: boolean;
  sessions: RuntimeSessionLease[];
  plugins: HostPluginState[];
  checks: CliDoctorCheck[];
}

/** The plugin row: its version against its channel, and whether it still fits the runtime. */
export function pluginCheck(
  state: HostPluginState,
  input: {
    manifest: ReleaseManifest | null;
    runtimeVersion: string;
    cliVersion: string;
    env?: NodeJS.ProcessEnv;
  },
): CliDoctorCheck {
  const label = state.host === "claude-code" ? "Claude Code" : "Codex";
  const name = state.host === "claude-code" ? "plugin_claude_code" : "plugin_codex";
  const version = state.version ?? state.launcher?.version ?? "unknown";
  const steps = pluginUpdateCommands(state, input.env).join(" && ");
  const launcher = state.launcher;
  if (launcher?.launcherContract != null && launcher.launcherContract !== LAUNCHER_CONTRACT) {
    const pluginOlder = launcher.launcherContract < LAUNCHER_CONTRACT;
    return {
      name,
      status: "fail",
      detail: `the ${label} plugin ${version} speaks launcher contract ${launcher.launcherContract}, this runtime ${LAUNCHER_CONTRACT}: ${
        pluginOlder
          ? `update the plugin (${steps}). ${pluginActivation(state)}`
          : "update Pathrule (pathrule update), then restart the session"
      }`,
    };
  }
  if (
    launcher?.minRuntime &&
    (compareVersions(input.runtimeVersion, launcher.minRuntime) ?? 0) < 0
  ) {
    return {
      name,
      status: "fail",
      detail: `the ${label} plugin ${version} needs Pathrule ${launcher.minRuntime} or newer; the runtime is ${input.runtimeVersion}. Run: pathrule update, then restart the session`,
    };
  }
  // The plugin's channel: the public marketplace's verified release, or, for the marketplace
  // `pathrule integrations` writes on this machine, the version this CLI would write.
  const latest =
    state.marketplace?.source === "directory"
      ? input.cliVersion
      : input.manifest
        ? (channelReleaseOf(
            input.manifest,
            state.host === "claude-code" ? "claude-code-plugin" : "codex-plugin",
            state.host === "claude-code" ? "claude-marketplace" : "codex-marketplace",
            "latest",
          )?.version ?? null)
        : null;
  if (!latest || (compareVersions(latest, version) ?? 0) <= 0) {
    return {
      name,
      status: "pass",
      detail: `${version}${state.autoUpdate ? ` (${label} updates it by itself)` : ""}`,
    };
  }
  if (state.autoUpdate) {
    return {
      name,
      status: "pass",
      detail: `${version}; ${label} updates it to ${latest} by itself. ${pluginActivation(state)}`,
    };
  }
  return {
    name,
    status: "warn",
    detail: `${latest} is available (installed ${version}; automatic updates are off: ${state.autoUpdateReason}). Run: ${steps}. ${pluginActivation(state)}`,
  };
}

function cliCheck(result: CliUpdateCheckResult, plan: CliUpdatePlan): CliDoctorCheck {
  const where = `${result.current_version} via ${result.install_method}, ${result.track} track`;
  const when = result.checked_at
    ? `verified ${result.checked_at.replace("T", " ").slice(0, 16)}`
    : null;
  const step = nextStep(plan);
  if (result.reason === "disabled")
    return { name: "cli_version", status: "pass", detail: `${where}; updates are turned off` };
  if (!result.source) {
    return {
      name: "cli_version",
      status: "pass",
      detail:
        result.reason === "not_checked"
          ? `${where}; not checked yet (run pathrule update to check now)`
          : result.reason === "http_error" ||
              result.reason === "not_json" ||
              result.reason === "too_large"
            ? `${where}; no release information is published yet`
            : `${where}; could not check for updates (${result.reason ?? "no answer"})`,
    };
  }
  if (result.update_required) {
    return {
      name: "cli_version",
      status: "fail",
      detail: `${where}; this version is outdated for the latest Cloud capabilities${step ? `. ${step}` : ""}`,
    };
  }
  if (result.update_available) {
    return {
      name: "cli_version",
      status: "warn",
      detail: `${where}; ${result.latest_version} is available${step ? `. ${step}` : ""}`,
    };
  }
  return {
    name: "cli_version",
    status: "pass",
    detail: `${where}; up to date${when ? ` (${when})` : ""}`,
  };
}

/** What `pathrule doctor` shows about updates and compatibility. */
export async function updatesReport(input: {
  env: NodeJS.ProcessEnv;
  version: string;
  fetchImpl: typeof fetch;
  /** A person at a terminal ran doctor: it may ask the release service when the disk copy is stale. */
  interactive?: boolean;
}): Promise<UpdatesReport> {
  const { env, version } = input;
  const policy = await getUpdatePolicy(env);
  const install = thisInstall(env);
  const background = automaticChecksEnabled({ env, install });
  // Doctor asks the release service itself only for a person at a terminal, and only when the
  // copy on disk is stale; a machine-read run (--json, a pipe, CI) answers from disk and sends
  // nothing.
  const network = background && input.interactive === true && updateCheckDue(readUpdateState(env));
  const { result, plan, manifest } = await checkCliUpdate(version, env, input.fetchImpl, {
    install,
    network,
  });
  const checks: CliDoctorCheck[] = [cliCheck(result, plan)];
  checks.push({
    name: "update_checks",
    status: "pass",
    detail: updatesDisabled(env)
      ? "turned off on this machine (PATHRULE_DISABLE_UPDATES)"
      : `${policy.value === "automatic" ? "Automatic" : "Notify only"} (update.policy ${policy.value}${
          policy.source === "default" ? ", the default" : ""
        }); ${
          !background
            ? install.method === "source"
              ? "a source build checks only on request (pathrule update)"
              : "no background check here (CI or NO_UPDATE_CHECK); pathrule update checks on request"
            : policy.value === "automatic"
              ? install.method === "npm-global"
                ? "checks daily and installs updates once no Pathrule session is running"
                : "checks daily; this install is updated by its owner, Pathrule shows how"
              : "checks daily and installs nothing without pathrule update"
        }`,
  });
  if (manifest && !plan.cloud.ok) {
    checks.push({
      name: "cloud_compatibility",
      status: plan.cloud.reason === "client_outdated" ? "fail" : "warn",
      detail:
        plan.cloud.reason === "client_outdated"
          ? `${plan.cloud.detail}. Update Pathrule to continue using the latest Cloud capabilities`
          : plan.cloud.detail,
    });
  }

  const sessions = activeRuntimeSessions(env);
  const older = sessions.filter((s) => s.version !== version);
  if (older.length > 0) {
    checks.push({
      name: "running_sessions",
      status: "warn",
      detail: `${older.length} running Pathrule process${older.length === 1 ? "" : "es"} (${[...new Set(older.map((s) => `${s.kind} ${s.version}`))].join(", ")}) still run an older version; restart their agent sessions to use ${version}`,
    });
  }

  const runtimeVersion =
    (await readRuntimeManifest(env).catch(() => null))?.runtime_version ?? version;
  const plugins = [readClaudeCodePluginState({ env }), readCodexPluginState({ env })].filter(
    (p) => p.installed,
  );
  for (const plugin of plugins) {
    checks.push(pluginCheck(plugin, { manifest, runtimeVersion, cliVersion: version, env }));
  }

  return {
    cli: result,
    policy: policy.value,
    automatic_checks: background,
    sessions,
    plugins,
    checks,
  };
}
