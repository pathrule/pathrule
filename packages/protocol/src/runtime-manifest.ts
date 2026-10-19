// SPDX-License-Identifier: Apache-2.0
/**
 * The runtime manifest: how a provider plugin's launcher finds the Pathrule runtime on this machine.
 *
 * The runtime (the open `@pathrule/cli` package, wherever it is installed) writes it beside the
 * canonical hook it installs, at `<PATHRULE_HOME>/bin/runtime.json`. A launcher reads it and never
 * guesses a path, a version or a mode. Everything a launcher may rely on is versioned here:
 * `launcher_contract` moves only when a launcher written for an older runtime can no longer drive
 * this one.
 */

export const RUNTIME_MANIFEST_FILE = "runtime.json";
export const RUNTIME_MANIFEST_SCHEMA = 1;
/** Bump when a launcher written against an older runtime cannot drive this one. */
export const LAUNCHER_CONTRACT = 1;

export type RuntimeMode = "local" | "cloud";

/** A process launch: the program, its arguments and the environment it adds. */
export interface RuntimeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RuntimeManifest {
  schema_version: typeof RUNTIME_MANIFEST_SCHEMA;
  launcher_contract: number;
  /** Version of the runtime package that wrote this file. */
  runtime_version: string;
  /** `HOOK_EXTENSION_CONTRACT` of the installed hook. */
  hook_extension_contract: number;
  /** The hook index schema versions the installed hook reads. */
  hook_index_schemas: number[];
  /** Absolute path of the canonical hook script. */
  hook: string;
  /**
   * How to run the runtime's own CLI: a Node binary, its entry script and the environment that
   * binary needs (an Electron helper runs as Node only with `ELECTRON_RUN_AS_NODE`).
   */
  cli: { node: string; entry: string; env?: Record<string, string> };
  /** The MCP server this machine's chosen mode launches. Absent until a setup chose a mode. */
  mcp?: RuntimeLaunch;
  mode?: RuntimeMode;
  /**
   * Hook-triggered maintenance (a stale index refreshed in the background, learning evidence
   * drained at the end of a turn). It runs only after a setup recorded the person's consent.
   */
  maintenance: { consent: boolean; recorded_at?: string };
  written_at: string;
}

/**
 * An MCP launch's environment is the runtime's own MCP entry (the same one `pathrule install` writes
 * into an agent's config): the mode, and an account edition's public client configuration. A key
 * whose name says it holds a credential is dropped, and so is anything that is not a plain
 * environment name with a bounded value.
 */
const LAUNCH_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const LAUNCH_ENV_CREDENTIAL = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|SERVICE_ROLE|API_KEY|COOKIE)/;

function keepLaunchEnv(key: string, value: unknown): value is string {
  return (
    LAUNCH_ENV_NAME.test(key) &&
    !LAUNCH_ENV_CREDENTIAL.test(key) &&
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096
  );
}

/** Environment keys the CLI launch in the manifest may carry. */
export const RUNTIME_CLI_ENV_ALLOWLIST: readonly string[] = ["ELECTRON_RUN_AS_NODE"];

/**
 * Keep the launch environment a manifest may carry: with an allowlist, only those keys; without
 * one, every plain key that does not name a credential.
 */
export function sanitizeRuntimeLaunchEnv(
  env: Record<string, unknown> | undefined,
  allowlist?: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== "object") return out;
  for (const [key, value] of Object.entries(env)) {
    if (allowlist && !allowlist.includes(key)) continue;
    if (keepLaunchEnv(key, value)) out[key] = value;
  }
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseLaunch(value: unknown): RuntimeLaunch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { command?: unknown; args?: unknown; env?: unknown };
  if (typeof v.command !== "string" || v.command.length === 0 || !isStringArray(v.args)) return undefined;
  return {
    command: v.command,
    args: v.args,
    env: sanitizeRuntimeLaunchEnv(v.env as Record<string, unknown> | undefined),
  };
}

/** Parse a manifest read from disk. Null for anything that is not a well-formed schema 1 manifest. */
export function parseRuntimeManifest(raw: unknown): RuntimeManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.schema_version !== RUNTIME_MANIFEST_SCHEMA) return null;
  if (typeof m.launcher_contract !== "number" || typeof m.runtime_version !== "string") return null;
  if (typeof m.hook_extension_contract !== "number") return null;
  if (!Array.isArray(m.hook_index_schemas) || !m.hook_index_schemas.every((n) => typeof n === "number")) {
    return null;
  }
  if (typeof m.hook !== "string" || m.hook.length === 0) return null;
  const cli = m.cli as { node?: unknown; entry?: unknown; env?: unknown } | undefined;
  if (!cli || typeof cli.node !== "string" || typeof cli.entry !== "string") return null;
  const maintenance = m.maintenance as { consent?: unknown; recorded_at?: unknown } | undefined;
  const mcp = parseLaunch(m.mcp);
  return {
    schema_version: RUNTIME_MANIFEST_SCHEMA,
    launcher_contract: m.launcher_contract,
    runtime_version: m.runtime_version,
    hook_extension_contract: m.hook_extension_contract,
    hook_index_schemas: m.hook_index_schemas as number[],
    hook: m.hook,
    cli: {
      node: cli.node,
      entry: cli.entry,
      ...(cli.env && typeof cli.env === "object"
        ? { env: sanitizeRuntimeLaunchEnv(cli.env as Record<string, unknown>, RUNTIME_CLI_ENV_ALLOWLIST) }
        : {}),
    },
    ...(mcp ? { mcp } : {}),
    ...(m.mode === "local" || m.mode === "cloud" ? { mode: m.mode } : {}),
    maintenance: {
      consent: maintenance?.consent === true,
      ...(typeof maintenance?.recorded_at === "string" ? { recorded_at: maintenance.recorded_at } : {}),
    },
    written_at: typeof m.written_at === "string" ? m.written_at : "",
  };
}

export type RuntimeCompatibility =
  | { ok: true }
  | { ok: false; reason: "launcher_contract" | "runtime_too_old"; detail: string };

/**
 * Whether a launcher built against `launcherContract` and needing at least `minRuntime` can drive the
 * runtime this manifest describes. Versions compare numerically by their dotted parts.
 */
export function runtimeCompatibility(
  manifest: Pick<RuntimeManifest, "launcher_contract" | "runtime_version">,
  required: { launcherContract: number; minRuntime: string },
): RuntimeCompatibility {
  if (manifest.launcher_contract !== required.launcherContract) {
    return {
      ok: false,
      reason: "launcher_contract",
      detail: `runtime speaks launcher contract ${manifest.launcher_contract}, the plugin needs ${required.launcherContract}`,
    };
  }
  if (compareRuntimeVersions(manifest.runtime_version, required.minRuntime) < 0) {
    return {
      ok: false,
      reason: "runtime_too_old",
      detail: `runtime ${manifest.runtime_version} is older than the ${required.minRuntime} the plugin needs`,
    };
  }
  return { ok: true };
}

/** Compare two dotted versions numerically (pre-release suffixes ignored). */
export function compareRuntimeVersions(a: string, b: string): number {
  const parts = (v: string) =>
    (v.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map((p) => Number.parseInt(p, 10));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
