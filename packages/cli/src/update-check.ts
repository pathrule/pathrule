// SPDX-License-Identifier: Apache-2.0
// The CLI's view of Pathrule updates: what the signed release manifest
// (@pathrule/protocol/release-manifest.js) offers this install, and the short notice an interactive
// terminal gets about it. The manifest is fetched by `pathrule update`, `pathrule doctor` and the
// background check (./updates/background.ts); everything else answers from the copy on disk.
import {
  fetchReleaseManifest,
  cachedReleaseManifest,
  releaseManifestUrl,
  type ReleaseFeedFailure,
} from "@pathrule/core/release/release-feed.js";
import {
  readUpdateState,
  updateUpdateState,
  type UpdateState,
} from "@pathrule/core/release/update-state.js";
import type {
  ReleaseManifest,
  ReleaseTrack,
  UpdateStatus,
} from "@pathrule/protocol/release-manifest.js";

import {
  getUpdatePolicy,
  updatesDisabled,
  type UpdatePolicy,
  type UpdatePolicyState,
} from "./config.js";
import { planCliUpdate, planNeedsAction, type CliUpdatePlan } from "./updates/cli-update.js";
import { detectInstallMethod, runningEntry, type InstallInfo } from "./updates/install-method.js";

export { isNewerVersion } from "@pathrule/protocol/release-manifest.js";
export { updatesDisabled } from "./config.js";

export interface CliUpdateCheckResult {
  checked: boolean;
  policy: string;
  current_version: string;
  latest_version: string | null;
  status: UpdateStatus;
  update_available: boolean;
  /** Older than the minimum the release manifest names, or no longer accepted by Pathrule Cloud. */
  update_required: boolean;
  track: ReleaseTrack;
  install_method: InstallInfo["method"];
  distribution: InstallInfo["distribution"];
  /** Who installs the update: a package manager, the editor, an agent plugin, a download. */
  owner: CliUpdatePlan["owner"];
  upgrade_command: string | null;
  /** `pathrule update` can install it itself. */
  runnable: boolean;
  guidance: string | null;
  restart: string | null;
  release_notes_url: string | null;
  /** Pathrule Cloud still accepts this client's contracts. */
  cloud_compatible: boolean;
  cloud_detail?: string;
  /** Where the answer came from: this check, or the last verified manifest on disk. */
  source: "network" | "cache" | null;
  checked_at: string | null;
  /** `not_checked`: answered from disk, by choice (a non-interactive doctor, a source build). */
  reason?: "disabled" | "not_checked" | ReleaseFeedFailure;
  url: string;
}

/** `PATHRULE_UPDATE_TRACK=stable` follows the stable track; everything else follows `latest`. */
export function updateTrack(env: NodeJS.ProcessEnv): ReleaseTrack {
  return env.PATHRULE_UPDATE_TRACK?.trim().toLowerCase() === "stable" ? "stable" : "latest";
}

export function thisInstall(env: NodeJS.ProcessEnv, entry: string = runningEntry()): InstallInfo {
  return detectInstallMethod({ entry, env });
}

function result(
  version: string,
  env: NodeJS.ProcessEnv,
  policy: UpdatePolicyState,
  plan: CliUpdatePlan,
  found: {
    source: "network" | "cache" | null;
    checkedAt: string | null;
    reason?: CliUpdateCheckResult["reason"];
  },
): CliUpdateCheckResult {
  const latest = plan.assessment?.latest ?? null;
  const status = plan.assessment?.status ?? "unknown";
  return {
    checked: found.source === "network",
    policy: policy.value,
    current_version: version,
    latest_version: latest?.version ?? null,
    status,
    update_available: status === "update_available" || status === "update_required",
    update_required:
      status === "update_required" || (!plan.cloud.ok && plan.cloud.reason === "client_outdated"),
    track: plan.track,
    install_method: plan.install.method,
    distribution: plan.install.distribution,
    owner: plan.owner,
    upgrade_command: plan.command,
    runnable: plan.runnable,
    guidance: plan.guidance,
    restart: plan.assessment?.restart ?? null,
    release_notes_url: latest?.release_notes_url ?? null,
    cloud_compatible: plan.cloud.ok,
    ...(plan.cloud.ok ? {} : { cloud_detail: plan.cloud.detail }),
    source: found.source,
    checked_at: found.checkedAt,
    ...(found.reason ? { reason: found.reason } : {}),
    url: releaseManifestUrl(env),
  };
}

/**
 * Check for a CLI update on request: fetch and verify the manifest, falling back to the last
 * verified copy when the network does not answer. `update.policy manual` stops only the automatic
 * checks; `PATHRULE_DISABLE_UPDATES=1` stops this one too.
 */
export async function checkCliUpdate(
  version: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  options: {
    install?: InstallInfo;
    now?: () => Date;
    /** False: answer from the verified manifest on disk only, sending nothing anywhere. */
    network?: boolean;
  } = {},
): Promise<{
  result: CliUpdateCheckResult;
  plan: CliUpdatePlan;
  manifest: ReleaseManifest | null;
}> {
  const policy = await getUpdatePolicy(env);
  const install = options.install ?? thisInstall(env);
  const track = updateTrack(env);
  if (updatesDisabled(env)) {
    const plan = planCliUpdate({ manifest: null, install, current: version, track });
    return {
      result: result(version, env, policy, plan, {
        source: null,
        checkedAt: null,
        reason: "disabled",
      }),
      plan,
      manifest: null,
    };
  }
  if (options.network === false) {
    const cached = cachedReleaseManifest(env, { now: options.now?.() });
    const plan = planCliUpdate({
      manifest: cached?.manifest ?? null,
      install,
      current: version,
      track,
    });
    return {
      result: result(version, env, policy, plan, {
        source: cached ? "cache" : null,
        checkedAt: cached?.checkedAt ?? null,
        reason: "not_checked",
      }),
      plan,
      manifest: cached?.manifest ?? null,
    };
  }
  const fetched = await fetchReleaseManifest({
    env,
    fetchImpl,
    now: options.now,
    userAgent: `pathrule-cli/${version}`,
  });
  const verified = fetched.ok ? fetched : fetched.cached;
  const manifest = verified?.manifest ?? null;
  const plan = planCliUpdate({ manifest, install, current: version, track });
  return {
    result: result(version, env, policy, plan, {
      source: fetched.ok ? "network" : verified ? "cache" : null,
      checkedAt: verified?.checkedAt ?? null,
      ...(fetched.ok ? {} : { reason: fetched.reason }),
    }),
    plan,
    manifest,
  };
}

/** The plan the last verified manifest on disk gives, without the network. */
export function cachedCliUpdatePlan(
  version: string,
  env: NodeJS.ProcessEnv,
  options: { install?: InstallInfo; now?: Date } = {},
): CliUpdatePlan | null {
  const cached = cachedReleaseManifest(env, { now: options.now });
  if (!cached) return null;
  return planCliUpdate({
    manifest: cached.manifest,
    install: options.install ?? thisInstall(env),
    current: version,
    track: updateTrack(env),
  });
}

const NOTICE_REPEAT_MS = 24 * 60 * 60 * 1000;

export interface CliUpdateNotice {
  key: string;
  version: string;
  lines: string[];
}

const MANAGERS: Partial<Record<CliUpdatePlan["install"]["method"], string>> = {
  homebrew: "Homebrew",
  winget: "WinGet",
  "pnpm-global": "pnpm",
  "yarn-global": "Yarn",
  "bun-global": "Bun",
  volta: "Volta",
};

/** What the person should do, in one line: `pathrule update`, the package manager's command, or who updates it. */
export function nextStep(plan: CliUpdatePlan): string | null {
  // A package manager owns the install: its own command first (`pathrule update` runs it too for
  // Homebrew, on request).
  const manager = MANAGERS[plan.install.method];
  if (manager && plan.command) {
    return `Your installation is managed by ${manager}. Run: ${plan.command}`;
  }
  if (plan.runnable) return "Run: pathrule update";
  if (plan.command && plan.owner === "package-manager" && !plan.guidance)
    return `Run: ${plan.command}`;
  return plan.guidance;
}

const AUTO_FAILURES: Record<string, string> = {
  permission_denied: "npm could not write to its install folder",
  integrity_mismatch: "the package did not match the signed release",
  integrity_missing: "the release names no package integrity",
  not_confirmed: "npm does not list this copy as its own",
  failed: "npm reported an error",
  not_installed: "npm finished without installing it",
};

/**
 * The notice an interactive terminal gets, from the state on disk, each at most once a day per
 * version: an update this machine installed (once), a required update, then an available one,
 * worded for the policy and for who installs it.
 */
export function cliUpdateNotice(
  plan: CliUpdatePlan | null,
  state: UpdateState,
  current: string,
  now: Date = new Date(),
  policy: UpdatePolicy = "automatic",
): CliUpdateNotice | null {
  const installed = state.installed;
  if (
    installed &&
    installed.component === "cli" &&
    !installed.announced &&
    installed.to === current
  ) {
    return {
      key: "cli:installed",
      version: installed.to,
      lines: [
        `Pathrule has been updated to ${installed.to}. Restart your session to activate the new version.`,
      ],
    };
  }
  if (!plan || !planNeedsAction(plan)) return null;
  const latest = plan.assessment?.latest?.version ?? null;
  const step = nextStep(plan);
  // Under `automatic`, a confirmed npm install updates itself: say only what keeps it from doing so.
  const selfUpdating =
    policy === "automatic" && plan.runnable && plan.install.method === "npm-global";
  const auto = state.auto?.version === latest ? state.auto : undefined;
  let notice: CliUpdateNotice | null = null;
  if (
    plan.assessment?.status === "update_required" ||
    (!plan.cloud.ok && plan.cloud.reason === "client_outdated")
  ) {
    notice = {
      key: "cli:update_required",
      version: latest ?? current,
      lines: [
        "Your Pathrule CLI and MCP server are outdated. Update them to continue using the latest Cloud capabilities.",
        ...(step ? [step] : []),
      ],
    };
  } else if (plan.assessment?.status === "update_available" && latest) {
    if (selfUpdating && auto?.outcome === "waiting_for_sessions") {
      notice = {
        key: "cli:update_waiting",
        version: latest,
        lines: [
          `Pathrule ${latest} is available. It installs automatically once no Pathrule session is running.`,
          "To install it now: pathrule update (running sessions keep their version until they restart)",
        ],
      };
    } else if (selfUpdating && auto && AUTO_FAILURES[auto.outcome]) {
      notice = {
        key: "cli:update_failed",
        version: latest,
        lines: [
          `Pathrule ${latest} could not be installed automatically: ${AUTO_FAILURES[auto.outcome]}. ${current} keeps running.`,
          "Run: pathrule update",
        ],
      };
    } else if (!selfUpdating) {
      notice = {
        key: "cli:update_available",
        version: latest,
        lines: [
          `Pathrule ${latest} is available. You're using ${current}.`,
          ...(step ? [step] : []),
        ],
      };
    }
  }
  if (!notice) return null;
  const last = state.notified?.[notice.key];
  if (last && last.version === notice.version) {
    const age = now.getTime() - Date.parse(last.at);
    if (age >= 0 && age < NOTICE_REPEAT_MS) return null;
  }
  return notice;
}

/** Remember that a notice was shown, so the next commands stay quiet about it. */
export function recordNoticeShown(
  env: NodeJS.ProcessEnv,
  notice: CliUpdateNotice,
  now: Date = new Date(),
): void {
  updateUpdateState(env, (state) => {
    const next = {
      ...state,
      notified: {
        ...state.notified,
        [notice.key]: { version: notice.version, at: now.toISOString() },
      },
    };
    if (notice.key === "cli:installed" && next.installed)
      next.installed = { ...next.installed, announced: true };
    return next;
  });
}

/** The notice for this run, if there is one to show, read from disk only. */
export function pendingCliUpdateNotice(
  version: string,
  env: NodeJS.ProcessEnv,
  options: { now?: Date; policy?: UpdatePolicy; install?: InstallInfo } = {},
): CliUpdateNotice | null {
  if (updatesDisabled(env)) return null;
  const now = options.now ?? new Date();
  return cliUpdateNotice(
    cachedCliUpdatePlan(version, env, { now, install: options.install }),
    readUpdateState(env),
    version,
    now,
    options.policy ?? "automatic",
  );
}

/**
 * A Claude Code or Codex plugin update the host will not install by itself, for a person at a
 * terminal: once a day per version, with the host's own commands. Read from disk only.
 */
export async function pendingPluginNotice(
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): Promise<CliUpdateNotice | null> {
  if (updatesDisabled(env)) return null;
  const manifest = cachedReleaseManifest(env, { now })?.manifest;
  if (!manifest) return null;
  const {
    readClaudeCodePluginState,
    readCodexPluginState,
    pluginUpdateCommands,
    pluginActivation,
  } = await import("@pathrule/integrations/native/host-plugin-state.js");
  const { channelReleaseOf, isNewerVersion } =
    await import("@pathrule/protocol/release-manifest.js");
  const state = readUpdateState(env);
  for (const plugin of [readClaudeCodePluginState({ env }), readCodexPluginState({ env })]) {
    if (!plugin.installed || plugin.autoUpdate || plugin.marketplace?.source === "directory")
      continue;
    const claude = plugin.host === "claude-code";
    const latest = channelReleaseOf(
      manifest,
      claude ? "claude-code-plugin" : "codex-plugin",
      claude ? "claude-marketplace" : "codex-marketplace",
      "latest",
    )?.version;
    if (!latest || !plugin.version || !isNewerVersion(latest, plugin.version)) continue;
    const key = `plugin:${plugin.host}`;
    const last = state.notified?.[key];
    if (last?.version === latest) {
      const age = now.getTime() - Date.parse(last.at);
      if (age >= 0 && age < NOTICE_REPEAT_MS) continue;
    }
    return {
      key,
      version: latest,
      lines: [
        `The Pathrule plugin ${latest} is available for ${claude ? "Claude Code" : "Codex"}. You're using ${plugin.version}.`,
        `Run: ${pluginUpdateCommands(plugin, env).join(" && ")}. ${pluginActivation(plugin)}`,
      ],
    };
  }
  return null;
}
