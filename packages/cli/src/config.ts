// SPDX-License-Identifier: Apache-2.0
// `pathrule config`: the CLI's own preferences, kept in the signed-in user's config, and the
// settings the installed plugins own.
import {
  readUpdatePreference,
  writeUpdatePreference,
} from "@pathrule/core/release/update-state.js";
import { readUserConfig, updateUserConfig } from "@pathrule/core/storage/config-store.js";

import { readDeviceDefault } from "@pathrule/core/workspace/folder-mode.js";

import { cloudNamed } from "./capabilities/folder-edition.js";
import { writeDeviceDefault } from "./capabilities/selection.js";
import { cliAccount, cliPlugins, type CliConfigExtension, type CliConfigState } from "./plugin.js";

/**
 * How Pathrule updates itself. Two choices only:
 * - `automatic` (the default): check in the background, install updates where the install can be
 *   updated safely (./updates/background.ts), never interrupt a running session, and say when a
 *   restart activates the new version;
 * - `notify`: check in the background and say what is available and how to install it, installing
 *   nothing without an explicit `pathrule update`.
 * The earlier values are read as their meaning today: `manual` is `notify`, `auto` is `automatic`;
 * stored preferences are not rewritten. Turning updates off is not a choice:
 * `PATHRULE_DISABLE_UPDATES=1` is a technical switch (no background network at all), and CI never
 * checks in the background (`backgroundChecksAllowed`).
 */
export type UpdatePolicy = "automatic" | "notify";

export interface UpdatePolicyState {
  key: "update.policy";
  value: UpdatePolicy;
  source: "env" | "config" | "default";
  configurable: boolean;
}

export const UPDATE_POLICIES: readonly UpdatePolicy[] = ["automatic", "notify"];

export function resolveUpdatePolicy(
  env: NodeJS.ProcessEnv,
  configValue?: string | null,
): UpdatePolicyState {
  const envPolicy = normalizePolicy(env.PATHRULE_UPDATE_POLICY);
  if (envPolicy) {
    return { key: "update.policy", value: envPolicy, source: "env", configurable: false };
  }

  const configured = normalizePolicy(configValue);
  if (configured) {
    return { key: "update.policy", value: configured, source: "config", configurable: true };
  }

  return { key: "update.policy", value: "automatic", source: "default", configurable: true };
}

/** Updates are off altogether, even on request: the technical switch `PATHRULE_DISABLE_UPDATES=1`. */
export function updatesDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.PATHRULE_DISABLE_UPDATES === "1" || env.PATHRULE_DISABLE_UPDATES === "true";
}

/**
 * Whether this environment may reach the network for an update on its own (whatever the policy):
 * not with updates disabled, not in CI, not under `NO_UPDATE_CHECK=1`.
 */
export function backgroundChecksAllowed(env: NodeJS.ProcessEnv): boolean {
  return !updatesDisabled(env) && env.CI !== "true" && env.NO_UPDATE_CHECK !== "1";
}

/** The plugin that owns a key, or null. */
function extensionFor(key: string): CliConfigExtension | null {
  return cliPlugins().find((p) => p.config?.owns(key))?.config ?? null;
}

/** The usage line `pathrule config` prints for a command it does not understand. */
export function configUsage(): string {
  const extensions = cliPlugins().flatMap((p) => (p.config ? [p.config] : []));
  const getKeys = ["default-mode", "update.policy", ...extensions.flatMap((e) => e.getKeys)];
  const setUsages = [
    "default-mode cloud|local",
    `update.policy ${UPDATE_POLICIES.join("|")}`,
    ...extensions.flatMap((e) => e.setUsages),
  ];
  const resetUsages = extensions.flatMap((e) => e.resetUsages);
  return [
    `Usage: pathrule config get <${getKeys.join("|")}>`,
    ...setUsages.map((usage) => `pathrule config set ${usage}`),
    ...resetUsages.map((usage) => `pathrule config reset ${usage}`),
  ].join(" OR ");
}

/** The key of the device default: the edition a folder with no edition of its own uses. */
export const DEFAULT_MODE_KEY = "default-mode";

const DEFAULT_MODE_SOURCES = {
  chosen: "chosen",
  "new-install": "default for a new install",
  "no-cloud": "this build names no Pathrule Cloud",
} as const;

/** The device default, as `config get default-mode` reports it. Machine-wide: no account involved. */
export function getDefaultMode(env: NodeJS.ProcessEnv): CliConfigState {
  const current = readDeviceDefault(env, { cloudAvailable: cloudNamed(env) });
  return { key: DEFAULT_MODE_KEY, value: current.mode, source: DEFAULT_MODE_SOURCES[current.source], configurable: true };
}

export async function getCliConfig(key: string, env: NodeJS.ProcessEnv): Promise<CliConfigState> {
  if (key === DEFAULT_MODE_KEY) return getDefaultMode(env);
  const extension = extensionFor(key);
  if (extension) return extension.get(key, env);
  if (key !== "update.policy") {
    throw new Error("unsupported_config_key");
  }
  return getUpdatePolicy(env);
}

/**
 * The update policy in force: the environment, the signed-in user's config, this machine's
 * preference (a CLI without an account keeps it there), or the default.
 */
export async function getUpdatePolicy(env: NodeJS.ProcessEnv): Promise<UpdatePolicyState> {
  const account = cliAccount();
  try {
    if (!account) throw new Error("config_requires_account");
    const config = await readUserConfig(await account.configUser(env), env);
    return resolveUpdatePolicy(env, config.update_policy ?? readUpdatePreference(env));
  } catch {
    return resolveUpdatePolicy(env, readUpdatePreference(env));
  }
}

export async function setCliConfig(
  key: string,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<CliConfigState> {
  if (key === DEFAULT_MODE_KEY) {
    const mode = value.toLowerCase().trim();
    if (mode !== "cloud" && mode !== "local") throw new Error("invalid_default_mode");
    if (mode === "cloud" && !cloudNamed(env)) throw new Error("cloud_unavailable");
    // Changes what a folder with no edition of its own uses; never a folder that has one.
    writeDeviceDefault(env, mode);
    return getDefaultMode(env);
  }
  const extension = extensionFor(key);
  if (extension) return extension.set(key, value, env);
  if (key !== "update.policy") {
    throw new Error("unsupported_config_key");
  }

  const policy = normalizePolicy(value);
  if (!policy) {
    throw new Error("invalid_update_policy");
  }
  // Stored per signed-in user; a CLI without an account keeps it on this machine.
  const account = cliAccount();
  if (account) {
    await updateUserConfig(await account.configUser(env), { update_policy: policy }, env);
  } else {
    writeUpdatePreference(env, policy);
  }
  return resolveUpdatePolicy(env, policy);
}

export async function resetCliConfig(
  key: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CliConfigState> {
  const extension = key ? extensionFor(key) : null;
  if (key && extension) return extension.reset(key, env);
  throw new Error("unsupported_config_reset_key");
}

/** A policy as written by a person, an environment or an older CLI, read as today's choice. */
export function normalizePolicy(value: string | null | undefined): UpdatePolicy | null {
  if (!value) return null;
  switch (
    value
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, "-")
  ) {
    case "automatic":
    case "auto":
      return "automatic";
    case "notify":
    case "notify-only":
    case "manual":
      return "notify";
    default:
      return null;
  }
}
