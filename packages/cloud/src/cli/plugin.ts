// SPDX-License-Identifier: Apache-2.0
/**
 * Pathrule Cloud in the CLI: the account commands (login, organizations, workspaces, team and
 * billing routes), the account path of the commands that also run locally, the MCP server's
 * account edition for `mcp run`, the hook's cloud extension, and the CLI's telemetry. Every command
 * runs on Pathrule Cloud (../native/config.ts names it; ./commands/native-commands.ts runs it);
 * a command the Cloud has no service for says so. Commands load their implementation when they
 * run, so `mcp run` only evaluates what the server needs.
 */
import { CLI_PACKAGE } from "@pathrule/cli/package-instance.js";
import { jsonEnvelope, statusLabel } from "@pathrule/cli/output.js";
import type {
  CliCommand,
  CliCommandContext,
  CliConfigExtension,
  CliHelpSection,
  CliJsonResult,
  CliSubcommand,
  CommandPlugin,
} from "@pathrule/cli/plugin.js";
import { CORE_PACKAGE } from "@pathrule/core/package-instance.js";
import { INTEGRATIONS_PACKAGE } from "@pathrule/integrations/package-instance.js";
import { MCP_PACKAGE } from "@pathrule/mcp/package-instance.js";
import { CLI_PLUGIN_CONTRACT } from "@pathrule/protocol/plugin-contracts.js";

import type { NativeAccount } from "../native/account.js";
import { nativeCloudConfig } from "../native/config.js";
import { ACCOUNT_HELP_TOPICS } from "./help-topics.js";
import { resolveCliMcpEntry } from "./install.js";

declare const __BUILD_CLOUD_HOOK_EXTENSIONS__: Record<string, string> | undefined;

const nativeAccount = () => import("./commands/native-account.js");
const nativeCommands = () => import("./commands/native-commands.js");
const nativeKnowledge = () => import("./commands/native-knowledge.js");
const openInstrument = () => import("@pathrule/cli/commands/instrument.js");
const telemetry = () => import("./telemetry.js");
const telemetryCommand = () => import("./commands/telemetry.js");

const NO_CLOUD = {
  code: "pathrule_cloud_not_configured",
  message: "This build names no Pathrule Cloud.",
};

function command(
  name: string,
  help: { section: CliHelpSection; rank: number; summary: string; usage?: readonly string[] },
  jsonRank: number | undefined,
  run: (ctx: CliCommandContext) => Promise<number>,
  json?: (ctx: CliCommandContext) => Promise<CliJsonResult>,
  quiet?: boolean,
): CliCommand {
  return {
    name,
    help,
    ...(jsonRank === undefined ? {} : { jsonRank }),
    ...(quiet ? { quiet } : {}),
    run,
    ...(json ? { json } : {}),
  };
}

/** A command that runs on Pathrule Cloud (./commands/native-commands.ts), by its name. */
function native(
  name: string,
  help: { section: CliHelpSection; rank: number; summary: string },
  jsonRank: number | undefined,
  quiet?: boolean,
): CliCommand {
  return command(
    name,
    help,
    jsonRank,
    async (ctx) => (await nativeCommands()).renderNative(ctx),
    async (ctx) => (await nativeCommands()).jsonNative(ctx),
    quiet,
  );
}

const ACCOUNT_COMMANDS: readonly CliCommand[] = [
  command(
    "login",
    { section: "account", rank: 10, summary: "Sign in to Pathrule Cloud" },
    30,
    async (ctx) => {
      const config = nativeCloudConfig(ctx.runtime.env);
      if (!config) {
        ctx.runtime.stderr.write(`${statusLabel("error", ctx.mode)} ${NO_CLOUD.message}\n`);
        return 1;
      }
      return (await nativeAccount()).renderNativeLogin(ctx.runtime, ctx.mode, config);
    },
    async (ctx) => {
      const config = nativeCloudConfig(ctx.runtime.env);
      if (!config)
        return {
          exitCode: 1,
          envelope: jsonEnvelope({
            command: ctx.command,
            cwd: ctx.runtime.cwd,
            ok: false,
            error: NO_CLOUD,
          }),
        };
      return (await nativeAccount()).runNativeLoginJson(ctx.runtime, ctx.command, config);
    },
    true,
  ),
  command(
    "logout",
    { section: "account", rank: 20, summary: "Sign out of Pathrule Cloud on this machine" },
    70,
    async (ctx) => (await nativeAccount()).renderNativeLogout(ctx.runtime, ctx.mode),
    async (ctx) => (await nativeAccount()).runNativeLogoutJson(ctx.runtime, ctx.command),
    true,
  ),
  command(
    "whoami",
    { section: "account", rank: 30, summary: "Show signed-in account" },
    60,
    async (ctx) => (await nativeAccount()).renderNativeWhoami(ctx.runtime, ctx.mode),
    async (ctx) => (await nativeAccount()).runNativeWhoamiJson(ctx.runtime, ctx.command),
  ),
  native(
    "org",
    { section: "account", rank: 40, summary: "List, show, or switch organization context" },
    80,
  ),
  native(
    "workspace",
    { section: "account", rank: 50, summary: "List, show, or switch workspace context" },
    90,
  ),
  native(
    "attach",
    { section: "workspace-setup", rank: 10, summary: "Attach the current folder to a workspace" },
    120,
  ),
  native(
    "detach",
    {
      section: "workspace-setup",
      rank: 20,
      summary: "Detach the current workspace from this machine",
    },
    130,
  ),
  native(
    "open",
    {
      section: "workspace-setup",
      rank: 70,
      summary: "Print/open Pathrule Cloud workspace, org, and admin routes",
    },
    220,
  ),
  // Pathrule Cloud only: off it, the native path says this build names no Pathrule Cloud.
  native(
    "activity",
    {
      section: "workspace-setup",
      rank: 90,
      summary:
        "Copy this folder's Local activity to its Pathrule Cloud workspace (import --from-local)",
    },
    225,
  ),
  native(
    "preflight",
    { section: "diagnostics", rank: 30, summary: "Check whether a planned action is allowed" },
    140,
  ),
  command(
    "telemetry",
    {
      section: "diagnostics",
      rank: 65,
      summary: "Confirm that this CLI sends no usage data",
      usage: ["pathrule telemetry [status]"],
    },
    202,
    async (ctx) => (await telemetryCommand()).renderTelemetry(ctx.args, ctx.runtime, ctx.mode),
    async (ctx) => (await telemetryCommand()).runTelemetryJson(ctx.runtime, ctx.command, ctx.args),
    // The person is looking at it: no first-use notice after it.
    true,
  ),
  native(
    "billing",
    { section: "team-billing", rank: 10, summary: "Open organization billing in Pathrule Cloud" },
    300,
  ),
  native(
    "team",
    {
      section: "team-billing",
      rank: 20,
      summary: "List organization members/invites or open team management in Pathrule Cloud",
    },
    310,
  ),
  native(
    "invite",
    { section: "team-billing", rank: 30, summary: "Invite a teammate to the current organization" },
    320,
  ),
  native(
    "upgrade",
    {
      section: "team-billing",
      rank: 40,
      summary: "Open the billing plan picker in Pathrule Cloud",
    },
    330,
  ),
  native(
    "reactivate",
    { section: "team-billing", rank: 50, summary: "Open billing reactivation in Pathrule Cloud" },
    340,
  ),
];

/** The account path of a command that also runs locally. Help and order are the open command's. */
function accountPath(name: string): CliCommand {
  return {
    name,
    run: async (ctx) => (await nativeCommands()).renderNative(ctx),
    json: async (ctx) => (await nativeCommands()).jsonNative(ctx),
  };
}

const TELEMETRY_CONFIG: CliConfigExtension = {
  getKeys: ["telemetry.enabled", "telemetry.id"],
  setUsages: ["telemetry.enabled true|false"],
  resetUsages: ["telemetry-id"],
  owns: (key) => key === "telemetry.enabled" || key === "telemetry.id" || key === "telemetry-id",
  get: async (key, env) => {
    const t = await telemetry();
    if (!t.isCliTelemetryConfigKey(key)) throw new Error("unsupported_config_key");
    return t.getCliTelemetryConfig(key, env);
  },
  set: async (key, value, env) => {
    if (key === "telemetry.enabled") return (await telemetry()).setCliTelemetryEnabled(value, env);
    if (key === "telemetry.id") throw new Error("use_config_reset_telemetry_id");
    throw new Error("unsupported_config_key");
  },
  reset: async (key, env) => {
    if (key === "telemetry-id" || key === "telemetry.id") {
      return (await telemetry()).resetCliTelemetryId(env);
    }
    throw new Error("unsupported_config_reset_key");
  },
};

/**
 * The `Next:` line for a doctor report, from the account's checks (commands/native-commands.ts
 * nativeDoctorChecks): a folder in conflict chooses its edition, a Pathrule Cloud folder signs in,
 * then gets its workspace. A Pathrule Local folder's checks all pass, so it gets none.
 */
function doctorNextStep(checks: readonly { name: string; status: string }[]): string | null {
  const status = (name: string) => checks.find((check) => check.name === name)?.status;
  if (status("cwd_attach") === "fail") return "pathrule setup --cloud or pathrule setup --local";
  if (status("auth") === "fail") return "pathrule login";
  if (status("cwd_attach") === "warn") return "pathrule setup --cloud";
  return null;
}

/** The account's `pathrule instrument` subcommands besides `events`: the Signals page of the console. */
const instrumentSubcommand = (rank: number): CliSubcommand => ({
  rank,
  run: async (ctx) => (await nativeCommands()).renderNative(ctx),
  json: async (ctx) => (await nativeCommands()).jsonNative(ctx),
});
const INSTRUMENT_SUBCOMMANDS: Readonly<Record<string, CliSubcommand>> = {
  status: instrumentSubcommand(10),
  // A Pathrule Cloud folder's groups come from the Cloud, a Pathrule Local folder's from Local; a
  // Cloud folder that cannot be read says why, never answering from Local.
  events: {
    rank: 20,
    run: async (ctx) =>
      (await openInstrument()).renderEventsCommand(
        ctx,
        ctx.args.slice(1),
        (await nativeKnowledge()).readRuntimeEventsHere,
      ),
    json: async (ctx) =>
      (await openInstrument()).eventsJson(
        ctx,
        ctx.args.slice(1),
        (await nativeKnowledge()).readRuntimeEventsHere,
      ),
  },
  keys: instrumentSubcommand(30),
  sdk: instrumentSubcommand(40),
};

/** The person's id on Pathrule Cloud, or null when signed out. */
async function signedInUser(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!nativeCloudConfig(env)) return null;
  const { readNativeSession } = await import("../native/credentials.js");
  return (await readNativeSession({ env }).catch(() => null))?.user_id ?? null;
}

/**
 * `native`: a native account the composition opted into (../native/account.ts), given to the host
 * and the MCP server this CLI starts. Without one, the account is Pathrule Cloud's own session on
 * this machine (../native/runtime.ts).
 */
export function cloudCliPlugin(options: { native?: NativeAccount } = {}): CommandPlugin {
  return {
    name: "cloud",
    contract: CLI_PLUGIN_CONTRACT,
    sharedPackages: [CLI_PACKAGE, CORE_PACKAGE, INTEGRATIONS_PACKAGE, MCP_PACKAGE],
    // The official release feed lives on Pathrule's servers, so the account's plugin asks for it.
    passiveUpdateNotice: true,
    commands: ACCOUNT_COMMANDS,
    // `pathrule instrument` is open (its `events` reads Pathrule Local); the account adds these.
    subcommands: { instrument: INSTRUMENT_SUBCOMMANDS },
    helpTopics: ACCOUNT_HELP_TOPICS,
    account: {
      commands: {
        init: accountPath("init"),
        setup: accountPath("setup"),
        sync: accountPath("sync"),
        search: accountPath("search"),
        memory: accountPath("memory"),
        rule: accountPath("rule"),
        skill: accountPath("skill"),
      },
      mcpEntry: resolveCliMcpEntry,
      // Pathrule Cloud runs no daemon on this machine.
      afterInstall: async () => undefined,
      doctorChecks: async (env, cwd) => (await nativeCommands()).nativeDoctorChecks(env, cwd),
      doctorNextStep,
      authorizeSupportBundle: async (env) =>
        (await nativeCommands()).assertNativeSupportBundle(env),
      configUser: async (env) => {
        const user = await signedInUser(env);
        if (!user) throw new Error("Not signed in to Pathrule Cloud. Run pathrule login.");
        return user;
      },
      signedInUser,
      // `pathrule status` is the open CLI's; this is its account part (`whoami` stays the account's).
      status: async (env, cwd, folder) =>
        (await nativeAccount()).nativeAccountStatus({ env, cwd, folder }),
    },
    telemetry: {
      commandFinished: async (env, event) =>
        (await telemetry()).recordCliCommandTelemetry(env, event),
      doctorFinished: async (env, managedFiles) =>
        (await telemetry()).recordManagedFileTelemetry(env, managedFiles),
    },
    passiveNotice: async (env) => (await telemetry()).cliTelemetryFirstUseNotice(env),
    config: TELEMETRY_CONFIG,
    hookExtensions: () =>
      typeof __BUILD_CLOUD_HOOK_EXTENSIONS__ === "object" &&
      __BUILD_CLOUD_HOOK_EXTENSIONS__ !== null
        ? __BUILD_CLOUD_HOOK_EXTENSIONS__
        : {},
    mcpPlugins: async () => [
      (await import("../mcp/plugin.js")).cloudMcpPlugin({ native: options.native }),
    ],
    hostPlugins: async () => [
      (await import("./host-plugin.js")).cloudCliHostPlugin({ native: options.native }),
    ],
  };
}

/** What the CLI loads when it finds this package installed beside it (`cli/plugin-discovery.ts`). */
export default cloudCliPlugin;
