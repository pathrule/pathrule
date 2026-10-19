// SPDX-License-Identifier: Apache-2.0
/**
 * What the CLI asks of its plugins. The CLI is open and runs the local store on its own: setup,
 * sync, the knowledge commands, install, doctor, `me`, `mcp run`. A plugin adds commands, and at
 * most one adds an account edition: the account path of the commands that also run locally. A
 * composition root passes its plugins to `main` (or `runCli`), which installs them here before any
 * command runs. Every call site names its open default, which is what the CLI does with no plugin
 * installed and what `--local` does with one.
 */
import type { Writable } from "node:stream";

import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import type { ManagedFileOwnershipSummary } from "@pathrule/core/storage/managed-file-ownership.js";
import type { FolderMode, FolderModeResolution } from "@pathrule/core/workspace/folder-mode.js";
import type { HostPlugin } from "@pathrule/host/plugin.js";
import type { McpServerEntry } from "@pathrule/integrations/mcp-types.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { MCP_PACKAGE } from "@pathrule/mcp/package-instance.js";
import type { McpPlugin } from "@pathrule/mcp/plugin.js";
import { assertSharedPackages, type PackageInstance } from "@pathrule/protocol/package-instance.js";
// The contract version lives only in `protocol`: a plugin must read it from its own copy, never
// through this module, which would hand it the CLI's number.
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { ParsedCliArgs } from "./args.js";
import type { RunNpm } from "./capabilities/npm.js";
import type { CliDoctorCheck } from "./doctor.js";
import type { CliJsonEnvelope, CliOutputMode } from "./output.js";
import { CLI_PACKAGE } from "./package-instance.js";

/** The shared packages, as this CLI resolved them. A plugin must have resolved the same copies. */
export const CLI_SHARED_PACKAGES: readonly PackageInstance[] = [
  CLI_PACKAGE,
  CORE_PACKAGE,
  INTEGRATIONS_PACKAGE,
  MCP_PACKAGE,
];

export interface CliRuntime {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
  fetch?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  stdinIsTTY?: boolean;
  /** Whether stderr is a terminal a person reads. By default, whether this process's stderr is. */
  stderrIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  promptLine?: (prompt: string) => Promise<string>;
  /** Asks for a secret without echoing it. By default a hidden prompt on this process's terminal. */
  promptSecret?: (prompt: string) => Promise<string>;
  editText?: (initialValue: string, fileNameHint: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * How this CLI runs itself as another process: the program and the arguments before a command.
   * By default this process's Node and entry; a composition that runs elsewhere (VS Code's bundled
   * CLI under Electron) or a test says otherwise.
   */
  selfCommand?: { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** How `pathrule update` runs npm. By default npm beside this Node (`capabilities/npm.ts`). */
  runNpm?: RunNpm;
}

/** One run of one command. */
export interface CliCommandContext {
  /** The command as typed: `memory`, `rule` and `skill` share one handler. */
  command: string;
  /** The positional arguments after the command. */
  args: string[];
  flags: ParsedCliArgs["flags"];
  runtime: CliRuntime;
  mode: CliOutputMode;
  /** What `setup` or `init` decided before the account's setup runs; absent elsewhere. */
  setupPlan?: CliSetupPlan;
}

/**
 * The folder's edition change that `pathrule setup` or `init` settled before the account's setup
 * runs (capabilities/onboarding.ts). An account setup that finds none was run with no change.
 */
export interface CliSetupPlan {
  /** The edition the folder had before this run; null when it followed the device default. */
  from: FolderMode | null;
  /** `project`: this folder's choice was recorded. `device`: only the device default changed. */
  scope: "project" | "device" | null;
  /**
   * Copying the folder's Local knowledge to its Cloud workspace: true (`--transfer`), false
   * (`--no-transfer`), or null: ask at a terminal, and elsewhere copy nothing and say so.
   */
  transfer: boolean | null;
  /** The AI client `--target` names, for the MCP entries setup writes; null for every client. */
  target: string | null;
}

/** The account's part of `pathrule status` for one folder. */
export interface CliStatusSection {
  /** Printed after the folder's lines, one each. */
  lines: string[];
  /** `status --json` carries it as `account`. */
  data: Record<string, unknown>;
  /** What the person must act on (signed out for a Cloud folder, no access); status exits 1. */
  problem: { code: string; message: string; next?: string } | null;
}

export interface CliJsonResult {
  exitCode: number;
  envelope: CliJsonEnvelope;
}

/** The sections of `pathrule help`, in the order they print. */
export const CLI_HELP_SECTIONS = [
  { id: "quick-start", title: "Quick Start" },
  { id: "account", title: "Account & Context" },
  { id: "workspace-setup", title: "Workspace Setup" },
  { id: "knowledge", title: "Knowledge" },
  { id: "diagnostics", title: "Diagnostics & Maintenance" },
  { id: "team-billing", title: "Team & Billing" },
  { id: "additional", title: "Additional Commands" },
] as const;

export type CliHelpSection = (typeof CLI_HELP_SECTIONS)[number]["id"];

export interface CliCommand {
  readonly name: string;
  /**
   * Its line in `pathrule help`: the section, its place in it, and what the command does.
   * `usage` lines are what `pathrule <command> --help` and `pathrule help <command>` print under
   * the summary; without them it prints `pathrule <command> [options]`.
   */
  readonly help?: { section: CliHelpSection; rank: number; summary: string; usage?: readonly string[] };
  /** Its place in the `commands` list of `pathrule help --json`. Absent: not listed. */
  readonly jsonRank?: number;
  /** No passive notice (the daily update hint) after this command. */
  readonly quiet?: boolean;
  /** `run` answers `--json` itself, with its own envelope. */
  readonly writesOwnJson?: boolean;
  run(ctx: CliCommandContext): Promise<number>;
  /**
   * The `--json` form, whose envelope the CLI prints. A command with neither this nor
   * `writesOwnJson` answers `--json` with `unknown_command`.
   */
  json?(ctx: CliCommandContext): Promise<CliJsonResult>;
}

/** A subcommand a plugin adds to an open command (`me context`); `rank` places it in the usage line. */
export interface CliSubcommand {
  readonly rank: number;
  run(ctx: CliCommandContext): Promise<number>;
  /** The `--json` form, where the open command prints JSON (`instrument`). */
  json?(ctx: CliCommandContext): Promise<CliJsonResult>;
}

/** A topic of `pathrule help <topic>`. */
export interface CliHelpTopic {
  readonly name: string;
  readonly rank: number;
  readonly text: string;
}

/** An entry of the `Options:` block of `pathrule help`, as printed (it may span lines). */
export interface CliHelpOption {
  readonly rank: number;
  readonly text: string;
}

/** The commands that run against the local store with `--local`, and in the account without it. */
export type CliLocalCommand = "init" | "setup" | "sync" | "search" | "memory" | "rule" | "skill";

/**
 * The account edition. Signing in, organizations, team state and telemetry live in the account;
 * the open commands ask it only at the call sites below.
 */
export interface CliAccountEdition {
  /** The account path of a command that also runs locally. `--local` runs the open one. */
  readonly commands: Readonly<Partial<Record<CliLocalCommand, CliCommand>>>;
  /**
   * No longer read: `pathrule install` writes one entry whatever the folder's edition, and the server
   * resolves each call's folder. Kept optional so a plugin built against the older contract loads.
   */
  mcpEntry?(env: NodeJS.ProcessEnv): McpServerEntry;
  /** After a successful `pathrule install`. */
  afterInstall(runtime: CliRuntime, mode: CliOutputMode): Promise<void>;
  /** The account's doctor checks, which come before the open ones. */
  doctorChecks(env: NodeJS.ProcessEnv, cwd: string): Promise<CliDoctorCheck[]>;
  /** The `Next:` line doctor prints for these checks, or null. */
  doctorNextStep(checks: readonly CliDoctorCheck[]): string | null;
  /** Throws when the account does not allow writing a support bundle now. */
  authorizeSupportBundle(env: NodeJS.ProcessEnv): Promise<void>;
  /** The user whose config `pathrule config` reads and writes. Throws when signed out. */
  configUser(env: NodeJS.ProcessEnv): Promise<string>;
  /** The signed-in user, or null. Never throws. */
  signedInUser(env: NodeJS.ProcessEnv): Promise<string | null>;
  /** The account's part of `pathrule status` for `cwd`, whose edition `folder` resolved. Never throws. */
  status?(env: NodeJS.ProcessEnv, cwd: string, folder: FolderModeResolution): Promise<CliStatusSection>;
}

/** What a plugin observes. It must never change what a command does or prints. */
export interface CliTelemetry {
  commandFinished(
    env: NodeJS.ProcessEnv,
    event: { command: string; exitCode: number; appVersion: string; durationMs: number },
  ): Promise<void>;
  /** The managed files `doctor --json` found. */
  doctorFinished(
    env: NodeJS.ProcessEnv,
    managedFiles: ManagedFileOwnershipSummary[],
  ): Promise<void>;
}

/** A setting `pathrule config` shows. */
export interface CliConfigState {
  key: string;
  value: string | boolean;
  source: string;
  configurable: boolean;
}

/** Settings a plugin owns. */
export interface CliConfigExtension {
  /** The keys `config get` takes, as the usage line lists them. */
  readonly getKeys: readonly string[];
  /** The `config set` forms the usage line lists (`telemetry.enabled true|false`). */
  readonly setUsages: readonly string[];
  /** The `config reset` forms the usage line lists. */
  readonly resetUsages: readonly string[];
  owns(key: string): boolean;
  get(key: string, env: NodeJS.ProcessEnv): Promise<CliConfigState>;
  set(key: string, value: string, env: NodeJS.ProcessEnv): Promise<CliConfigState>;
  reset(key: string, env: NodeJS.ProcessEnv): Promise<CliConfigState>;
}

export interface CommandPlugin {
  readonly name: string;
  /**
   * The `CLI_PLUGIN_CONTRACT` the plugin was built against: imported from
   * `@pathrule/protocol/plugin-contracts.js`, the plugin's own copy.
   */
  readonly contract: number;
  /**
   * The copy of each shared package the plugin imports: the `*_PACKAGE` token of every package it
   * uses among cli, core, integrations and mcp, as the plugin resolved it. The CLI refuses a plugin
   * that resolved another copy than its own.
   */
  readonly sharedPackages: readonly PackageInstance[];
  /**
   * Kept for plugins built against earlier releases: the daily update check no longer depends on
   * it. Every released install checks by default (`update.policy automatic`); see ./run.ts.
   */
  readonly passiveUpdateNotice?: boolean;
  /** Runs once, when the plugin is installed, before any command or `mcp run`. */
  activate?(): void;
  readonly commands?: readonly CliCommand[];
  /** Subcommands added to open commands, by command and subcommand. */
  readonly subcommands?: Readonly<Record<string, Readonly<Record<string, CliSubcommand>>>>;
  readonly helpTopics?: readonly CliHelpTopic[];
  readonly helpOptions?: readonly CliHelpOption[];
  /** The account edition. At most one plugin supplies it. */
  readonly account?: CliAccountEdition;
  /** Hook extensions written beside the hook, by file name. */
  hookExtensions?(): Readonly<Record<string, string>>;
  /** The MCP plugins `pathrule mcp run` starts the server with, loaded when it starts. */
  mcpPlugins?(): Promise<McpPlugin[]>;
  /** The host plugins `pathrule host run` starts the host with, loaded when it starts. */
  hostPlugins?(): Promise<HostPlugin[]>;
  readonly telemetry?: CliTelemetry;
  /**
   * A notice for the person after an interactive command, printed only to a terminal: the telemetry
   * first-use notice. Null when there is nothing to say. It must not prompt, and it decides itself
   * whether it has been shown before.
   */
  passiveNotice?(env: NodeJS.ProcessEnv): Promise<string | null>;
  readonly config?: CliConfigExtension;
}

/** A plugin, or how to load it. Loading is deferred so `mcp run` evaluates only what it needs. */
export type CliPluginSource = CommandPlugin | (() => Promise<CommandPlugin>);

let installedPlugins: readonly CommandPlugin[] = [];

/** Install the plugins of this process. Later calls replace earlier ones. */
export function installCliPlugins(plugins: readonly CommandPlugin[]): void {
  checkCliPlugins(plugins);
  for (const plugin of plugins) plugin.activate?.();
  installedPlugins = [...plugins];
}

/**
 * Adds plugins to this process's, for a capability loaded while a command runs (`pathrule
 * setup`). They are checked together with the installed ones, and only the new ones are activated.
 */
export function addCliPlugins(plugins: readonly CommandPlugin[]): void {
  const fresh = plugins.filter((plugin) => !installedPlugins.some((p) => p.name === plugin.name));
  const all = [...installedPlugins, ...fresh];
  checkCliPlugins(all);
  for (const plugin of fresh) plugin.activate?.();
  installedPlugins = all;
}

/**
 * Throws when these plugins cannot run together in this CLI: a plugin built for another contract, a
 * plugin that resolved a second copy of a shared package, or a role that more than one plugin claims.
 */
export function checkCliPlugins(plugins: readonly CommandPlugin[]): void {
  for (const plugin of plugins) {
    if (plugin.contract !== CLI_PLUGIN_CONTRACT) {
      throw new Error(
        `CLI plugin ${plugin.name} was built for contract ${plugin.contract}; this CLI speaks ${CLI_PLUGIN_CONTRACT}.`,
      );
    }
    assertSharedPackages({
      seam: "CLI",
      plugin: plugin.name,
      host: CLI_SHARED_PACKAGES,
      resolved: plugin.sharedPackages,
    });
  }
  const owners = plugins.filter((p) => p.account);
  if (owners.length > 1) {
    throw new Error(
      `At most one CLI plugin may supply the account edition; got ${owners.map((p) => p.name).join(", ")}.`,
    );
  }
}

export async function loadCliPlugins(
  sources: readonly CliPluginSource[],
): Promise<CommandPlugin[]> {
  return Promise.all(sources.map((source) => (typeof source === "function" ? source() : source)));
}

export function cliPlugins(): readonly CommandPlugin[] {
  return installedPlugins;
}

/** The installed account edition, or null. */
export function cliAccount(): CliAccountEdition | null {
  return installedPlugins.find((p) => p.account)?.account ?? null;
}

/** Whether an installed plugin turns on the daily update notice. */
export function cliPassiveUpdateNotice(): boolean {
  return installedPlugins.some((p) => p.passiveUpdateNotice === true);
}

/** The host plugins of the installed plugins, in their order. */
export async function cliHostPlugins(): Promise<HostPlugin[]> {
  const lists = await Promise.all(installedPlugins.map((p) => p.hostPlugins?.() ?? []));
  return lists.flat();
}

/** The hook extensions the installed plugins ship, by file name. */
export function cliHookExtensions(): Record<string, string> {
  return Object.assign({}, ...installedPlugins.map((p) => p.hookExtensions?.() ?? {}));
}
