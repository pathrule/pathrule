// SPDX-License-Identifier: Apache-2.0
// The doctor report: Node, the MCP entries of every AI client, and the files Pathrule manages here,
// after the account's own checks when an account edition is installed.
import { configHome } from "./install-local.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  localRuntimePaths,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "@pathrule/core/storage/paths.js";
import {
  readManagedFileOwnershipManifest,
  summarizeManagedFileOwnership,
  type ManagedFileOwnershipSummary,
} from "@pathrule/core/storage/managed-file-ownership.js";
import {
  getInstallers,
  type ClientInstaller,
} from "@pathrule/integrations/mcp-installers/registry.js";
import { withLaunchCheck } from "@pathrule/integrations/mcp-installers/launch-target.js";
import { isNodeVersionSupported, MIN_NODE_VERSION } from "./node-version.js";
import {
  assertSupportBundleHasNoSecrets,
  redactSupportString,
} from "@pathrule/core/util/support-bundle.js";
import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

import { EDITION_TITLE, editionReason, folderEdition } from "./capabilities/folder-edition.js";
import { capabilityDoctorCheck } from "./capabilities/host.js";
import { CLI_VERSION } from "./cli-version.js";
import { cliPlatform } from "./platform.js";
import { cliAccount } from "./plugin.js";
import { updatesReport, type UpdatesReport } from "./updates/components.js";
import { detectInstallMethod, runningEntry } from "./updates/install-method.js";

export interface CliDoctorReport {
  ok: boolean;
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail?: string;
  }>;
  mcp: Array<{
    client: AgentTargetId;
    config_path: string;
    installed: boolean;
    readable: boolean;
    launch_command: string | null;
    launch_args: string[];
    stale_reason?: "missing-file" | "repo-relative-mcp-server" | "unknown-command";
    error?: string;
  }>;
  managed_files: ManagedFileOwnershipSummary[];
  /** Versions, updates and compatibility of every installed Pathrule component. */
  updates?: UpdatesReport;
}

export type CliDoctorCheck = CliDoctorReport["checks"][number];

export interface CliDoctorBundleResult {
  ok: boolean;
  path: string;
  report: CliDoctorReport;
}

const CLIENTS: AgentTargetId[] = ["claude-code", "cursor", "codex", "windsurf", "copilot"];

/**
 * `folder_edition`: the edition serving this folder and why, the device default, and the workspace
 * that answers. Fails on a conflict, or on a Cloud folder this run cannot serve; warns on a folder
 * not set up yet.
 */
export function folderEditionCheck(env: NodeJS.ProcessEnv, cwd: string): CliDoctorCheck {
  const folder = folderEdition(cwd, env);
  const device = `device default ${EDITION_TITLE[folder.deviceDefault.mode]}`;
  if (!folder.mode) {
    return {
      name: "folder_edition",
      status: "fail",
      detail: `${folder.conflict!.root} has a Pathrule Local and a Pathrule Cloud workspace and no choice between them: run \`pathrule setup --cloud\` or \`pathrule setup --local\``,
    };
  }
  const edition = `${EDITION_TITLE[folder.mode]} (${editionReason(folder)}); ${device}`;
  if (folder.mode === "cloud" && !cliAccount()) {
    return {
      name: "folder_edition",
      status: "fail",
      detail: `${edition}; Pathrule Cloud is not available in this run, and nothing is served from a Local store in its place`,
    };
  }
  const served = folder.mode === "local" ? folder.local?.workspaceId : folder.cloud?.workspaceId;
  if (!served) {
    return { name: "folder_edition", status: "warn", detail: `${edition}; not set up here yet: run \`pathrule setup\`` };
  }
  return { name: "folder_edition", status: "pass", detail: `${edition}; workspace ${served}` };
}

export async function runCliDoctor(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { fetchImpl?: typeof fetch; interactive?: boolean } = {},
): Promise<CliDoctorReport> {
  // Which edition serves this folder, then the account's checks (signed in, this folder's attachment).
  const checks: CliDoctorReport["checks"] = [
    folderEditionCheck(env, cwd),
    ...((await cliAccount()?.doctorChecks(env, cwd)) ?? []),
  ];
  // The capabilities the person chose (the npm CLI): whether each one is ready for this version.
  const capabilities = capabilityDoctorCheck();
  if (capabilities) checks.push(capabilities);

  // One row per (client, config file) — multi-config clients (copilot)
  // report the CLI config and the VS Code user mcp.json separately.
  const mcp = await Promise.all(
    CLIENTS.flatMap((c) => getInstallers(c).map((installer) => readMcpStatus(c, installer, env))),
  );

  // Surface runtime Node version and MCP launch staleness as
  // first-class doctor checks so users see exactly what to fix.
  if (!isNodeVersionSupported()) {
    checks.push({
      name: "node_version",
      status: "fail",
      detail: `Node ${process.versions.node} < required ${MIN_NODE_VERSION}; upgrade to fix MCP startup`,
    });
  } else {
    checks.push({
      name: "node_version",
      status: "pass",
      detail: `node ${process.versions.node}`,
    });
  }
  const staleClients = mcp.filter((m) => m.stale_reason);
  if (staleClients.length > 0) {
    // `install` rewrites Pathrule's entry in every build; the account's `repair` no longer exists.
    const fix = "pathrule install";
    checks.push({
      name: "mcp_launch",
      status: "warn",
      detail: `stale entries for ${staleClients.map((c) => `${c.client}:${c.stale_reason}`).join(", ")}; run \`${fix}\``,
    });
  }
  const managedFiles = summarizeManagedFileOwnership(
    await readManagedFileOwnershipManifest(cwd),
    "cli",
    CLI_VERSION,
  );
  const otherOwnerCount = managedFiles.filter((entry) => entry.status === "other_owner").length;
  const newerVersionCount = managedFiles.filter((entry) => entry.status === "newer_version").length;
  if (otherOwnerCount > 0 || newerVersionCount > 0) {
    checks.push({
      name: "managed_files",
      status: "warn",
      detail: managedFilesDetail(otherOwnerCount, newerVersionCount),
    });
  } else if (managedFiles.length > 0) {
    checks.push({
      name: "managed_files",
      status: "pass",
      detail: `${managedFiles.length} Pathrule-managed file${managedFiles.length === 1 ? "" : "s"} tracked`,
    });
  } else {
    checks.push({
      name: "managed_files",
      status: "pass",
      detail: "no Pathrule-managed files tracked yet",
    });
  }
  // Versions and compatibility: the signed release manifest (checked now, quietly offline), the
  // agent hosts' plugin state, running sessions and the model. Never installs anything.
  const updates = await updatesReport({
    env,
    version: CLI_VERSION,
    fetchImpl: options.fetchImpl ?? fetch,
    interactive: options.interactive,
  }).catch(() => null);
  if (updates) checks.push(...updates.checks);
  const failed = checks.some((check) => check.status === "fail");

  return {
    ok: !failed,
    checks,
    mcp,
    managed_files: managedFiles,
    ...(updates ? { updates } : {}),
  };
}

export async function writeCliDoctorBundle(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CliDoctorBundleResult> {
  await cliAccount()?.authorizeSupportBundle(env);
  const report = await runCliDoctor(env, cwd, options);
  const paths = localRuntimePaths(env);
  await mkdir(paths.supportDir, { recursive: true, mode: PATHRULE_DIR_MODE });
  await chmod(paths.supportDir, PATHRULE_DIR_MODE).catch(() => {});
  const filePath = join(
    paths.supportDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-doctor.json`,
  );
  const bundle = {
    schema_version: 2,
    produced_at: new Date().toISOString(),
    cwd_hash: hashForSupport(cwd),
    // Platform fields. Source code already excludes tokens/
    // emails/secret env values via assertSupportBundleHasNoSecrets +
    // redactDoctorReport; install_channel is a best-effort heuristic
    // derived from the running entrypoint path, never from network.
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    cli_version: CLI_VERSION,
    install_channel: detectInstallMethod({ entry: runningEntry(), env }).method,
    env_keys: Object.keys(env)
      .filter((key) => key.startsWith("PATHRULE_") || key === "CI" || key === "NO_COLOR")
      .sort(),
    report: redactDoctorReport(report),
  };
  assertSupportBundleHasNoSecrets(bundle);
  await writeFile(filePath, JSON.stringify(bundle, null, 2), {
    encoding: "utf8",
    mode: PATHRULE_FILE_MODE,
  });
  await chmod(filePath, PATHRULE_FILE_MODE).catch(() => {});
  return { ok: report.ok, path: filePath, report };
}

function redactDoctorReport(report: CliDoctorReport): CliDoctorReport {
  return {
    ok: report.ok,
    checks: report.checks.map((check) => ({
      ...check,
      detail: redactSupportText(check.detail),
    })),
    mcp: report.mcp.map((entry) => ({
      ...entry,
      config_path: redactPath(entry.config_path),
      error: redactSupportText(entry.error),
    })),
    managed_files: report.managed_files.map((entry) => ({
      ...entry,
      path: redactSupportText(entry.path) ?? entry.path,
    })),
    // Versions and states only: no install path, capability home or URL query.
    ...(report.updates
      ? {
          updates: {
            ...report.updates,
            checks: report.updates.checks.map((check) => ({
              ...check,
              detail: redactSupportText(check.detail),
            })),
            sessions: report.updates.sessions.map((s) => ({
              pid: s.pid,
              kind: s.kind,
              version: s.version,
              started_at: s.started_at,
            })),
            plugins: report.updates.plugins.map((p) => ({
              ...p,
              installPath: null,
              marketplace: p.marketplace ? { ...p.marketplace, location: null } : null,
            })),
          },
        }
      : {}),
  };
}

function managedFilesDetail(otherOwnerCount: number, newerVersionCount: number): string {
  const parts: string[] = [];
  if (otherOwnerCount > 0) {
    parts.push(
      `${otherOwnerCount} file${otherOwnerCount === 1 ? "" : "s"} last written by another surface`,
    );
  }
  if (newerVersionCount > 0) {
    parts.push(
      `${newerVersionCount} file${newerVersionCount === 1 ? "" : "s"} last written by a newer CLI`,
    );
  }
  return parts.join("; ");
}

function redactSupportText(value: string | undefined): string | undefined {
  if (!value) return value;
  return redactSupportString(value);
}

function redactPath(value: string): string {
  return redactSupportString(value, "path");
}

function hashForSupport(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function readMcpStatus(
  client: AgentTargetId,
  installer: ClientInstaller,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliDoctorReport["mcp"][number]> {
  // The home `pathrule install` writes under, so the doctor reads the config install wrote.
  const configPath = installer.homeConfigPath(configHome(env), cliPlatform(env));
  try {
    const body = await readFile(configPath, "utf8");
    // An entry whose files are gone (an app uninstalled, Node upgraded) is stale too.
    const info = withLaunchCheck(installer.getManagedEntry(body));
    return {
      client,
      config_path: configPath,
      readable: true,
      installed: info.present,
      launch_command: info.launchCommand,
      launch_args: info.launchArgs,
      ...(info.staleReason ? { stale_reason: info.staleReason } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        client,
        config_path: configPath,
        readable: false,
        installed: false,
        launch_command: null,
        launch_args: [],
      };
    }
    return {
      client,
      config_path: configPath,
      readable: false,
      installed: false,
      launch_command: null,
      launch_args: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
