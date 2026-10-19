// SPDX-License-Identifier: Apache-2.0
// `pathrule config` and `pathrule update`.
import { runNpm } from "../capabilities/npm.js";
import { CLI_VERSION } from "../cli-version.js";
import { listLocalWorkspaceStores } from "@pathrule/core/backend/local/workspace-stores.js";
import { readCloudFolderBindings, readFolderChoices } from "@pathrule/core/workspace/folder-mode.js";

import {
  configUsage,
  DEFAULT_MODE_KEY,
  getCliConfig,
  resetCliConfig,
  setCliConfig,
} from "../config.js";
import { jsonEnvelope, statusLabel, type CliOutputMode } from "../output.js";
import type { CliCommand, CliRuntime } from "../plugin.js";
import { checkCliUpdate, nextStep, type CliUpdateCheckResult } from "../update-check.js";
import { runCliUpdate, type CliUpdateOutcome, type CliUpdatePlan } from "../updates/cli-update.js";

export const configCommand: CliCommand = {
  name: "config",
  help: { section: "diagnostics", rank: 60, summary: "Read or write CLI preferences" },
  jsonRank: 190,
  run: (ctx) => renderConfig(ctx.args[0], ctx.args[1], ctx.args[2], ctx.runtime, ctx.mode),
  json: (ctx) => runConfigJson(ctx.runtime, ctx.args[0], ctx.args[1], ctx.args[2]),
};

/**
 * `pathrule update`: check the signed release manifest and install the update this install's
 * channel verifiably published, with the install's own package manager. `--check` only checks.
 * `--json` only checks too, unless `--apply` asks it to install.
 */
export const updateCommand: CliCommand = {
  name: "update",
  help: { section: "diagnostics", rank: 70, summary: "Check for and install Pathrule updates" },
  jsonRank: 200,
  quiet: true,
  run: (ctx) => renderUpdate(ctx.args, ctx.runtime, ctx.mode),
  json: (ctx) => runUpdateJson(ctx.runtime, ctx.flags.apply),
};

async function runConfigJson(
  runtime: CliRuntime,
  subcommand: string | undefined,
  key: string | undefined,
  value: string | undefined,
) {
  try {
    if (subcommand === "get" && key) {
      const data = await getCliConfig(key, runtime.env);
      return {
        exitCode: 0,
        envelope: jsonEnvelope({
          command: `config get ${key}`,
          cwd: runtime.cwd,
          ok: true,
          data,
        }),
      };
    }
    if (subcommand === "set" && key && value) {
      const data = await setCliConfig(key, value, runtime.env);
      return {
        exitCode: 0,
        envelope: jsonEnvelope({
          command: `config set ${key}`,
          cwd: runtime.cwd,
          ok: true,
          data,
        }),
      };
    }
    if (subcommand === "reset" && key) {
      const data = await resetCliConfig(key, runtime.env);
      return {
        exitCode: 0,
        envelope: jsonEnvelope({
          command: `config reset ${key}`,
          cwd: runtime.cwd,
          ok: true,
          data,
        }),
      };
    }
    return {
      exitCode: 64,
      envelope: jsonEnvelope({
        command: "config",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: "invalid_config_command",
          message: configUsage(),
        },
      }),
    };
  } catch (err) {
    return {
      exitCode: err instanceof Error && err.message.startsWith("invalid_") ? 64 : 1,
      envelope: jsonEnvelope({
        command: "config",
        cwd: runtime.cwd,
        ok: false,
        error: {
          code: err instanceof Error ? err.message : "config_failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    };
  }
}

async function runUpdateJson(runtime: CliRuntime, apply: boolean) {
  const { result, plan } = await checkCliUpdate(CLI_VERSION, runtime.env, runtime.fetch ?? fetch);
  const outcome = apply && result.update_available ? await install(plan, runtime) : null;
  const failed = outcome !== null && !outcome.ok;
  return {
    exitCode: failed ? 1 : 0,
    envelope: jsonEnvelope({
      command: "update",
      cwd: runtime.cwd,
      ok: !failed,
      data: { ...result, ...(outcome ? { outcome } : {}) },
      ...(failed && outcome && !outcome.ok
        ? { error: { code: outcome.status, message: outcome.detail } }
        : {}),
    }),
  };
}

function install(plan: CliUpdatePlan, runtime: CliRuntime): Promise<CliUpdateOutcome> {
  return runCliUpdate(plan, {
    env: runtime.env,
    cwd: runtime.cwd,
    runNpm: runtime.runNpm ?? runNpm,
  });
}

async function renderConfig(
  subcommand: string | undefined,
  key: string | undefined,
  value: string | undefined,
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  try {
    if (subcommand === "get" && key) {
      const config = await getCliConfig(key, runtime.env);
      runtime.stdout.write(`${key}=${config.value} (${config.source})\n`);
      return 0;
    }
    if (subcommand === "set" && key && value) {
      const config = await setCliConfig(key, value, runtime.env);
      runtime.stdout.write(`${statusLabel("ok", mode)} ${key}=${config.value}\n`);
      if (key === DEFAULT_MODE_KEY) {
        const own = foldersWithOwnEdition(runtime.env);
        runtime.stdout.write(
          `${statusLabel("info", mode)} New folders use ${config.value === "cloud" ? "Pathrule Cloud" : "Pathrule Local"}. ` +
            `Folders already set up keep their edition (${own} on this machine).\n`,
        );
      }
      return 0;
    }
    if (subcommand === "reset" && key) {
      const config = await resetCliConfig(key, runtime.env);
      runtime.stdout.write(`${statusLabel("ok", mode)} ${config.key}=${config.value}\n`);
      return 0;
    }
    runtime.stderr.write(`${statusLabel("error", mode)} ${configUsage()}\n`);
    return 64;
  } catch (err) {
    runtime.stderr.write(
      `${statusLabel("error", mode)} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return err instanceof Error && err.message.startsWith("invalid_") ? 64 : 1;
  }
}

/** How many folders on this machine have an edition of their own: a choice or a workspace. */
function foldersWithOwnEdition(env: NodeJS.ProcessEnv): number {
  const roots = new Set<string>([
    ...readFolderChoices(env).map((c) => c.root),
    ...listLocalWorkspaceStores(env).map((w) => w.localRootPath),
    ...readCloudFolderBindings(env).map((b) => b.root),
  ]);
  return roots.size;
}

const METHOD_LABELS: Record<CliUpdateCheckResult["install_method"], string> = {
  "npm-global": "npm (global)",
  "pnpm-global": "pnpm (global)",
  "yarn-global": "Yarn (global)",
  "bun-global": "Bun (global)",
  volta: "Volta",
  npx: "npx",
  project: "a project dependency",
  homebrew: "Homebrew",
  winget: "WinGet",
  standalone: "the standalone download",
  vscode: "the Pathrule extension",
  "agent-plugin": "an agent plugin",
  source: "a source build",
  unknown: "an unknown method",
};

async function renderUpdate(
  args: string[],
  runtime: CliRuntime,
  mode: CliOutputMode,
): Promise<number> {
  const out = (kind: "ok" | "warn" | "error" | "info", line: string) =>
    runtime.stdout.write(`${statusLabel(kind, mode)} ${line}\n`);
  const { result, plan } = await checkCliUpdate(CLI_VERSION, runtime.env, runtime.fetch ?? fetch);
  if (result.reason === "disabled") {
    out("info", "Updates are turned off on this machine (PATHRULE_DISABLE_UPDATES).");
    return 0;
  }
  if (!result.source) {
    out("warn", `Could not check for updates: ${whyNotChecked(result.reason)}.`);
    return 1;
  }
  runtime.stdout.write(
    `Pathrule ${result.current_version}, installed with ${METHOD_LABELS[result.install_method]}, ${result.track} track\n`,
  );
  if (result.source === "cache") {
    out(
      "info",
      `${capitalize(whyNotChecked(result.reason))}; this is what was verified at ${result.checked_at}.`,
    );
  }
  if (!result.cloud_compatible && result.cloud_detail) out("warn", result.cloud_detail);
  if (result.status === "unknown") {
    out("info", "No verified release is published for this install's channel yet.");
    return 0;
  }
  if (!result.update_available) {
    if (!result.cloud_compatible) {
      const step = nextStep(plan);
      if (step) runtime.stdout.write(`${step}\n`);
      return 0;
    }
    out("ok", `Pathrule ${result.current_version} is up to date.`);
    return 0;
  }
  out(
    result.update_required ? "warn" : "info",
    result.update_required
      ? `Pathrule ${result.latest_version} is required to keep working with the latest Cloud capabilities. You're using ${result.current_version}.`
      : `Pathrule ${result.latest_version} is available. You're using ${result.current_version}.`,
  );
  if (result.release_notes_url)
    runtime.stdout.write(`Release notes: ${result.release_notes_url}\n`);
  if (args.includes("--check") || !plan.runnable) {
    const step = nextStep(plan);
    if (step)
      runtime.stdout.write(
        `${step.startsWith("Run: pathrule update") && args.includes("--check") ? "Run: pathrule update" : step}\n`,
      );
    return 0;
  }
  runtime.stdout.write(
    `Updating with ${result.install_method === "homebrew" ? "Homebrew" : "npm"}...\n`,
  );
  return renderOutcome(await install(plan, runtime), runtime, mode);
}

/** Why a check did not produce a verified answer, for a person. */
function whyNotChecked(reason: CliUpdateCheckResult["reason"]): string {
  switch (reason) {
    case "offline":
      return "the release service did not answer; try again when you are online";
    case "http_error":
    case "not_json":
    case "too_large":
      return "the release service has no release information for this version yet";
    case "expired":
    case "not_yet_valid":
      return "the release information is out of date, so it was ignored";
    case "unsupported_schema":
      return "the release information is newer than this version reads";
    case "unknown_key":
    case "bad_signature":
    case "invalid":
    case "malformed":
    case "rollback":
      return "the release information did not verify, so it was ignored";
    default:
      return "no answer";
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderOutcome(
  outcome: CliUpdateOutcome,
  runtime: CliRuntime,
  mode: CliOutputMode,
): number {
  const out = (kind: "ok" | "warn" | "error" | "info", line: string) =>
    runtime.stdout.write(`${statusLabel(kind, mode)} ${line}\n`);
  if (outcome.ok) {
    if (outcome.status !== "updated") {
      out("ok", outcome.detail);
      return 0;
    }
    out(
      "ok",
      `Pathrule has been updated to ${outcome.to}. Restart your session to use the new version.`,
    );
    if (outcome.sessions.length > 0) {
      const n = outcome.sessions.length;
      out(
        "info",
        `${n} running Pathrule ${n === 1 ? "process keeps" : "processes keep"} ${[...new Set(outcome.sessions.map((s) => s.version))].join(", ")} until ${n === 1 ? "it restarts" : "they restart"} (MCP servers restart with their agent session).`,
      );
    }
    return 0;
  }
  const command = outcome.command ? `\nRun it yourself: ${outcome.command}` : "";
  switch (outcome.status) {
    case "not_runnable":
    case "not_confirmed":
      out("info", `${outcome.detail}${command}`);
      return 0;
    case "permission_denied":
      out(
        "error",
        `The package manager could not write to its install folder: ${outcome.detail}${command}\nSee https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally`,
      );
      return 1;
    case "integrity_mismatch":
      out("error", `Refusing to install: ${outcome.detail}. Nothing was changed.`);
      return 1;
    default:
      out("error", `The update did not complete: ${outcome.detail}.${command}`);
      return 1;
  }
}
