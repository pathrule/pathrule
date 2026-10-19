// SPDX-License-Identifier: Apache-2.0
// The CLI's router. It parses the arguments, finds the command among the open ones and the ones
// the installed plugins add, and runs it, in the terminal or as a `--json` envelope. What a command
// does lives with the command (./commands, and in the plugins); what every run does lives here: the
// passive notices after an interactive command, and telling the plugins' telemetry what ran.
import { parseCliArgs } from "./args.js";
import { capabilityWarnings } from "./capabilities/host.js";
import { CLI_VERSION } from "./cli-version.js";
import { configCommand, updateCommand } from "./commands/config.js";
import {
  memoryCommand,
  ruleCommand,
  searchCommand,
  skillCommand,
} from "./commands/content-local.js";
import { doctorCommand } from "./commands/doctor.js";
import { embeddingsCommand } from "./commands/embeddings.js";
import { topicsCommand } from "./commands/topics.js";
import { hostCommand } from "./commands/host.js";
import { ejectCommand, installCommand, uninstallCommand } from "./commands/install.js";
import { uiCommand } from "./commands/ui.js";
import { statusCommand } from "./commands/status.js";
import { initCommand, setupCommand, syncCommand } from "./commands/workspace-local.js";
import {
  CLI_HELP_TOPIC,
  helpFor,
  OPEN_HELP_OPTIONS,
  renderCommandHelp,
  renderHelp,
  sortedTopics,
} from "./help.js";
import { HOME_COMMAND, homeCommand, opensHome } from "./home/command.js";
import { jsonEnvelope, renderJson, statusLabel, type CliOutputMode } from "./output.js";
import {
  cliPlugins,
  installCliPlugins,
  type CliCommand,
  type CliCommandContext,
  type CliHelpTopic,
  type CliJsonResult,
  type CliRuntime,
  type CommandPlugin,
} from "./plugin.js";
import { getUpdatePolicy } from "./config.js";
import { cliSelfCommand } from "./local/self-command.js";
import { personAtTerminal } from "./terminal/profile.js";
import {
  pendingCliUpdateNotice,
  pendingPluginNotice,
  recordNoticeShown,
  thisInstall,
} from "./update-check.js";
import { automaticChecksEnabled, startBackgroundUpdateCheck } from "./updates/background.js";
import { meCommand } from "./user-intelligence.js";
import { instrumentCommand } from "./commands/instrument.js";
import { integrationsCommand } from "./commands/integrations.js";
import { indexCommand, learningCommand } from "./commands/maintenance.js";

export type { CliRuntime } from "./plugin.js";

export interface RunCliOptions {
  /** The plugins of this run. They replace whatever an earlier run installed. */
  plugins?: readonly CommandPlugin[];
  /**
   * The update notice after an interactive command, and the daily background check it starts
   * (./updates/background.ts). On for every released install by default (owner decision
   * 2026-10-13: `update.policy automatic` is the default); `false` turns both off for a composition
   * that reports updates itself.
   */
  passiveUpdateNotice?: boolean;
}

const OPEN_COMMANDS: readonly CliCommand[] = [
  homeCommand,
  setupCommand,
  initCommand,
  installCommand,
  uninstallCommand,
  ejectCommand,
  syncCommand,
  searchCommand,
  memoryCommand,
  ruleCommand,
  skillCommand,
  statusCommand,
  doctorCommand,
  configCommand,
  updateCommand,
  meCommand,
  hostCommand,
  embeddingsCommand,
  topicsCommand,
  uiCommand,
  instrumentCommand,
  integrationsCommand,
  indexCommand,
  learningCommand,
];

export async function runCli(
  argv: string[],
  runtime: CliRuntime,
  options: RunCliOptions = {},
): Promise<number> {
  installCliPlugins(options.plugins ?? []);
  const startedAt = Date.now();
  const parsed = parseCliArgs(argv, runtime.env);
  const mode: CliOutputMode = {
    json: parsed.flags.json,
    color: parsed.flags.color,
    interactive: parsed.flags.interactive,
    noOpen: parsed.flags.noOpen,
  };
  // Bare `pathrule`: the project home for a person at a terminal, help otherwise (a
  // pipe, CI, --json), exactly as before.
  const bare = parsed.positional.length === 0;
  const command = parsed.flags.version
    ? "version"
    : parsed.flags.help
      ? "help"
      : bare && opensHome(runtime, mode)
        ? HOME_COMMAND
        : parsed.command;
  const handler = registeredCommands().get(command);
  // `pathrule <command> ... --help` is help for that command, whatever follows it.
  const helpArgs = parsed.flags.help && parsed.positional.length > 0 && parsed.command !== "help";
  const ctx: CliCommandContext = {
    command,
    args: helpArgs ? parsed.positional.slice(0, 1) : parsed.positional.slice(1),
    flags: parsed.flags,
    runtime,
    mode,
  };

  if (mode.json && !handler?.writesOwnJson) {
    const result = handler?.json
      ? await handler.json(ctx)
      : command === "__scaffold"
        ? scaffoldResult(runtime)
        : unknownCommandResult(command, runtime);
    const warnings = capabilityWarnings();
    runtime.stdout.write(
      renderJson(warnings.length > 0 ? { ...result.envelope, warnings } : result.envelope),
    );
    await commandFinished(runtime, command, result.exitCode, startedAt);
    return result.exitCode;
  }

  let exitCode: number;
  if (handler) {
    exitCode = await handler.run(ctx);
  } else {
    runtime.stderr.write(
      `${statusLabel("error", mode)} Unknown command "${command}". Run pathrule help.\n`,
    );
    exitCode = 64;
  }

  if (!handler?.quiet) {
    await renderPassiveNotices(runtime, mode, options.passiveUpdateNotice !== false);
  }
  await commandFinished(runtime, command, exitCode, startedAt);
  return exitCode;
}

/** Every command of this run by name: the open ones, then the plugins'. */
function registeredCommands(): Map<string, CliCommand> {
  const commands = new Map<string, CliCommand>();
  const add = (command: CliCommand, owner: string) => {
    if (commands.has(command.name)) {
      throw new Error(`The command "${command.name}" is defined twice (again by ${owner}).`);
    }
    commands.set(command.name, command);
  };
  for (const command of OPEN_COMMANDS) add(command, "the CLI");
  for (const plugin of cliPlugins()) {
    for (const command of plugin.commands ?? []) add(command, plugin.name);
  }
  add(helpCommand(commands), "the CLI");
  add(versionCommand, "the CLI");
  return commands;
}

function helpTopics(): CliHelpTopic[] {
  return sortedTopics([CLI_HELP_TOPIC, ...cliPlugins().flatMap((p) => p.helpTopics ?? [])]);
}

function helpCommand(commands: ReadonlyMap<string, CliCommand>): CliCommand {
  const topics = helpTopics();
  const self: CliCommand = {
    name: "help",
    help: {
      section: "additional",
      rank: 10,
      summary: `Show this help, help for one command, or for ${topics.map((topic) => topic.name).join("/")}`,
      usage: [
        "pathrule help",
        "pathrule help <command>",
        "pathrule <command> --help",
        `pathrule help <${topics.map((topic) => topic.name).join("|")}>`,
      ],
    },
    jsonRank: 10,
    run: async ({ args, runtime, mode }) => {
      const help = helpFor(args[0], topics, mainText, commandText);
      if (!help.ok) {
        runtime.stderr.write(`${statusLabel("error", mode)} ${help.message}\n`);
        return 64;
      }
      runtime.stdout.write(help.text);
      return 0;
    },
    json: async ({ command, args, runtime }) => {
      const help = helpFor(args[0], topics, mainText, commandText);
      if (!help.ok) {
        return {
          exitCode: 64,
          envelope: jsonEnvelope({
            command,
            cwd: runtime.cwd,
            ok: false,
            error: {
              code: "invalid_help_topic",
              message: help.message,
            },
          }),
        };
      }
      return {
        exitCode: 0,
        envelope: jsonEnvelope({
          command,
          cwd: runtime.cwd,
          ok: true,
          data: {
            topic: help.topic,
            topics: topics.map((topic) => topic.name),
            text: help.text,
            commands: listed()
              .filter((entry) => entry.jsonRank !== undefined)
              .sort((a, b) => a.jsonRank! - b.jsonRank!)
              .map((entry) => entry.name),
          },
        }),
      };
    },
  };
  // Read when the command runs, once the map holds every command, this one and `version` too.
  const listed = () => [...commands.values()];
  const options = () => [...OPEN_HELP_OPTIONS, ...cliPlugins().flatMap((p) => p.helpOptions ?? [])];
  const mainText = () => renderHelp(listed(), options());
  const commandText = (name: string) => {
    const found = commands.get(name);
    return found?.help ? renderCommandHelp(found, options()) : null;
  };
  return self;
}

const versionCommand: CliCommand = {
  name: "version",
  help: { section: "additional", rank: 20, summary: "Print CLI version" },
  jsonRank: 20,
  run: async ({ runtime }) => {
    runtime.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  },
  json: async ({ command, runtime }) => ({
    exitCode: 0,
    envelope: jsonEnvelope({
      command,
      cwd: runtime.cwd,
      ok: true,
      data: { version: CLI_VERSION },
    }),
  }),
};

function scaffoldResult(runtime: CliRuntime): CliJsonResult {
  return {
    exitCode: 0,
    envelope: jsonEnvelope({
      command: "__scaffold",
      cwd: runtime.cwd,
      ok: true,
      data: {
        status: "not_implemented",
        phase: "m31a_cli_foundation",
      },
    }),
  };
}

function unknownCommandResult(command: string, runtime: CliRuntime): CliJsonResult {
  return {
    exitCode: 64,
    envelope: jsonEnvelope({
      command,
      cwd: runtime.cwd,
      ok: false,
      error: {
        code: "unknown_command",
        message: `Unknown command "${command}".`,
        remediation: [{ label: "Show help", command: "pathrule help" }],
      },
    }),
  };
}

async function renderPassiveNotices(
  runtime: CliRuntime,
  mode: CliOutputMode,
  updateNotice: boolean,
): Promise<void> {
  if (!mode.interactive) return;
  // A plugin's notice reaches a person or no one: a terminal, never a pipe or a log.
  if (runtime.stderrIsTTY ?? process.stderr.isTTY === true) {
    for (const plugin of cliPlugins()) {
      const notice = await plugin.passiveNotice?.(runtime.env).catch(() => null);
      if (notice) runtime.stderr.write(`${statusLabel("info", mode)} ${notice}\n`);
    }
  }
  if (updateNotice) await renderUpdateNotice(runtime, mode).catch(() => {});
}

/**
 * Pathrule updates, for a person at a terminal only (never a pipe, --json, CI or a dumb terminal):
 * the notice from what the last check found, then the next check, detached, when one is due.
 */
async function renderUpdateNotice(runtime: CliRuntime, mode: CliOutputMode): Promise<void> {
  if (!personAtTerminal(runtime, mode)) return;
  if (!(runtime.stderrIsTTY ?? process.stderr.isTTY === true)) return;
  const install = thisInstall(runtime.env);
  if (!automaticChecksEnabled({ env: runtime.env, install })) return;
  const policy = await getUpdatePolicy(runtime.env);
  // One update notice per command at most: the CLI's first, then an agent plugin its host does
  // not update by itself.
  const notice =
    pendingCliUpdateNotice(CLI_VERSION, runtime.env, { policy: policy.value, install }) ??
    (await pendingPluginNotice(runtime.env));
  if (notice) {
    for (const line of notice.lines) runtime.stderr.write(`${statusLabel("info", mode)} ${line}\n`);
    recordNoticeShown(runtime.env, notice);
  }
  startBackgroundUpdateCheck({
    self: runtime.selfCommand ?? cliSelfCommand(),
    // The detached copy loads no plugin, so it gets the policy the account may have stored.
    env: { ...runtime.env, PATHRULE_UPDATE_POLICY_RESOLVED: policy.value },
  });
}

async function commandFinished(
  runtime: CliRuntime,
  command: string,
  exitCode: number,
  startedAt: number,
): Promise<void> {
  for (const plugin of cliPlugins()) {
    await plugin.telemetry?.commandFinished(runtime.env, {
      command,
      exitCode,
      appVersion: CLI_VERSION,
      durationMs: Date.now() - startedAt,
    });
  }
}
