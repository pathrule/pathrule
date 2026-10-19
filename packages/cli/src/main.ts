// SPDX-License-Identifier: Apache-2.0
// How a CLI binary starts, with the plugins its distribution brings. Dispatch order matters:
//
//   1. Read the bare positional args (no flag normalisation is needed for the mcp-run check:
//      `pathrule mcp run` is a fixed two-token form).
//   2. If the user invoked `pathrule mcp run`, branch IMMEDIATELY into the MCP stdio runtime,
//      BEFORE any module that could write to stdout, schedule telemetry, start a work-state
//      tracker, hit the update endpoint, or print a banner. The only modules this path evaluates
//      are the Node version gate, the plugins it was given, and the stdio-safe MCP server.
//   3. Otherwise, run the full CLI.
//
// Stdio purity contract: the first byte this process writes to stdout on the `mcp run` path must
// be the start of a valid MCP JSON-RPC frame.
import { CLI_VERSION } from "./cli-version.js";
import { cliHostLaunch, selfCommandOf, setCliSelfCommand } from "./local/self-command.js";
import { isNodeVersionSupported, nodeVersionFailure } from "./node-version.js";
import {
  checkCliPlugins,
  installCliPlugins,
  loadCliPlugins,
  type CliPluginSource,
  type CommandPlugin,
} from "./plugin.js";

export interface CliMainOptions {
  /** The plugins of a composition that builds them in. */
  plugins?: readonly CliPluginSource[];
  /**
   * Run with the capabilities the person chose in `pathrule setup` (`capabilities/host.ts`), when
   * `plugins` is not given. The `pathrule` binary does; with nothing chosen, it is the local CLI.
   */
  discoverPlugins?: boolean;
  /** See `RunCliOptions.passiveUpdateNotice`: on unless a composition turns it off. */
  passiveUpdateNotice?: boolean;
}

export async function main(argv: string[], options: CliMainOptions = {}): Promise<void> {
  const isMcpRun = argv[0] === "mcp" && argv[1] === "run";
  // The binary: the stores' host can be launched as `<this Node> <this entry> host run`.
  setCliSelfCommand(selfCommandOf(process.argv[1]));

  if (isMcpRun) {
    if (!isNodeVersionSupported()) {
      const failure = nodeVersionFailure();
      process.stderr.write(`${failure.message}\n`);
      process.exit(78); // EX_CONFIG — runtime environment is unsupported.
    }
    const plugins = await usablePlugins(argv, options, { json: false });
    if (!plugins) {
      process.exitCode = PLUGIN_FAILURE_EXIT;
      return;
    }
    installCliPlugins(plugins);
    const { startPathruleMcpServer } = await import("@pathrule/mcp/server.js");
    const mcpPlugins = await Promise.all(plugins.map((plugin) => plugin.mcpPlugins?.() ?? []));
    // A lease while this server runs, so an update says it keeps the old version until its agent
    // session restarts, and no cleanup removes the capability files it loads. No stdout write.
    const { registerRuntimeSession } = await import("@pathrule/core/release/runtime-sessions.js");
    const { capabilityHost } = await import("./capabilities/host.js");
    registerRuntimeSession(process.env, {
      kind: "mcp",
      version: CLI_VERSION,
      ...(capabilityHost()?.home ? { capability_home: capabilityHost()!.home } : {}),
      ...(process.env.PATHRULE_PLUGIN_VERSION
        ? { plugin_version: process.env.PATHRULE_PLUGIN_VERSION }
        : {}),
    });
    const { cliPackageDir } = await import("./capabilities/home.js");
    const { detectInstallMethod, installedCliVersion, runningEntry } =
      await import("./updates/install-method.js");
    const packageDir = cliPackageDir();
    await startPathruleMcpServer({
      stdioSafe: true,
      plugins: mcpPlugins.flat(),
      hostLaunch: cliHostLaunch(),
      version: CLI_VERSION,
      installedVersion: () => installedCliVersion(packageDir),
      distribution: detectInstallMethod({ entry: runningEntry(), env: process.env }).distribution,
    });
    return;
  }

  // The detached update check (./updates/background.ts): no plugin, no output, no capability install.
  if (argv[0] === "__update-check") {
    if (!isNodeVersionSupported()) process.exit(78);
    const { backgroundCheckMain } = await import("./updates/background.js");
    await backgroundCheckMain(process.env, process.cwd()).catch(() => {});
    return;
  }

  if (!isNodeVersionSupported()) {
    const failure = nodeVersionFailure();
    // For non-MCP commands, the json flag may apply; emit a stable JSON
    // envelope when requested, otherwise a plain human error.
    if (argv.includes("--json")) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: failure.code, message: failure.message }) + "\n",
      );
    } else {
      process.stderr.write(`${failure.message}\n`);
    }
    process.exit(78);
  }
  const plugins = await usablePlugins(argv, options, { json: argv.includes("--json") });
  if (!plugins) {
    process.exitCode = PLUGIN_FAILURE_EXIT;
    return;
  }
  const { runCli } = await import("./run.js");
  process.exitCode = await runCli(
    argv,
    {
      cwd: process.cwd(),
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    },
    { plugins, passiveUpdateNotice: options.passiveUpdateNotice },
  );
}

/** EX_CONFIG: an installed plugin cannot run with this CLI, which is an install to repair. */
const PLUGIN_FAILURE_EXIT = 78;

/**
 * The plugins of this run, loaded and checked, or null after saying why they cannot run: a plugin
 * that does not load, is built for another contract, or resolved a second copy of a shared package,
 * and a chosen capability that cannot be prepared and must not be run without (Cloud). Such a run
 * stops here; it never runs as if the plugin were absent.
 */
async function usablePlugins(
  argv: readonly string[],
  options: CliMainOptions,
  output: { json: boolean },
): Promise<CommandPlugin[] | null> {
  try {
    if (!options.plugins && options.discoverPlugins) {
      const { prepareCapabilities } = await import("./capabilities/host.js");
      const prepared = await prepareCapabilities({
        argv,
        env: process.env,
        stderr: process.stderr,
      });
      if (!prepared.ok) {
        throw Object.assign(new Error(prepared.message), { code: "capability_unavailable" });
      }
      return prepared.plugins;
    }
    const plugins = await loadCliPlugins(options.plugins ?? []);
    checkCliPlugins(plugins);
    return plugins;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      (error as { code?: unknown } | null)?.code === "capability_unavailable"
        ? "capability_unavailable"
        : "plugin_unusable";
    if (output.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: code, message }) + "\n");
    } else {
      process.stderr.write(`pathrule: ${message}\n`);
    }
    return null;
  }
}
