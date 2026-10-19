// SPDX-License-Identifier: Apache-2.0
// `pathrule host`: the Pathrule host of this Pathrule home, a process of its own that
// every Pathrule surface shares (@pathrule/host).
//
//   run     serves in the foreground with the host plugins of this CLI's plugins (the engine's,
//           Cloud's), until a signal, `host stop`, or the idle timeout
//   start   launches it in the background, unless one already runs
//   status  whether one runs: its version, its plugins, and what keeps it running
//   stop    asks it to stop, and sends SIGTERM when it does not answer
//
// `--idle-timeout <minutes>` (run, start): stop after that long without a request, unless a plugin
// keeps the host running. Without it the host runs until it is stopped.
import { connectHost, HostClientError } from "@pathrule/host/client.js";
import { processAlive, readHostRecord } from "@pathrule/host/discovery.js";
import { HostLaunchError, hostLogFile, launchHost } from "@pathrule/host/launch.js";
import { runHostProcess } from "@pathrule/host/process.js";
import type { HostDiscoveryRecord, HostHello } from "@pathrule/protocol/host-rpc.js";

import { registerRuntimeSession } from "@pathrule/core/release/runtime-sessions.js";

import { capabilityHost } from "../capabilities/host.js";
import { CLI_VERSION } from "../cli-version.js";
import { thisInstall } from "../update-check.js";
import { automaticChecksEnabled, startPeriodicUpdateChecks } from "../updates/background.js";
import { cliSelfCommand, selfCommandOf, type CliSelfCommand } from "../local/self-command.js";
import { jsonEnvelope, statusLabel } from "../output.js";
import {
  cliHostPlugins,
  type CliCommand,
  type CliCommandContext,
  type CliJsonResult,
  type CliRuntime,
} from "../plugin.js";

const USAGE = "Usage: pathrule host <run|start|status|stop> [--idle-timeout <minutes>] [--json]";
const STOP_WAIT_MS = 10_000;
const TERM_WAIT_MS = 5_000;

export const hostCommand: CliCommand = {
  name: "host",
  help: {
    section: "additional",
    rank: 10,
    summary: "Run the local host every Pathrule surface shares",
    usage: [USAGE.slice("Usage: ".length)],
  },
  jsonRank: 205,
  quiet: true,
  run: (ctx) => runHost(ctx),
  json: (ctx) => hostJson(ctx),
};

/** How this CLI runs itself as another process: the runtime's, else what the binary said. */
function selfCommand(runtime: CliRuntime): CliSelfCommand {
  const self = runtime.selfCommand ?? cliSelfCommand() ?? selfCommandOf(process.argv[1]);
  if (!self) throw new Error("cannot tell which file this CLI runs from");
  return self;
}

/** The `--idle-timeout` minutes, as milliseconds; undefined when absent. Throws on a bad value. */
export function parseIdleTimeout(args: readonly string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    let value: string | undefined;
    if (arg === "--idle-timeout") value = args[i + 1];
    else if (arg.startsWith("--idle-timeout=")) value = arg.slice("--idle-timeout=".length);
    else continue;
    const minutes = Number(value);
    if (value === undefined || !Number.isFinite(minutes) || minutes <= 0) {
      throw Object.assign(new Error("--idle-timeout takes a number of minutes above 0"), {
        code: "invalid_idle_timeout",
      });
    }
    return Math.round(minutes * 60_000);
  }
  return undefined;
}

function idleArgs(idleTimeoutMs: number | undefined): string[] {
  return idleTimeoutMs === undefined ? [] : ["--idle-timeout", String(idleTimeoutMs / 60_000)];
}

interface HostState {
  running: boolean;
  pid?: number;
  version?: string;
  startedAt?: string;
  plugins?: HostHello["plugins"];
  idle?: HostHello["idle"];
}

function stateOf(hello: HostHello): HostState {
  return {
    running: true,
    pid: hello.pid,
    version: hello.version,
    startedAt: hello.startedAt,
    plugins: hello.plugins,
    ...(hello.idle ? { idle: hello.idle } : {}),
  };
}

async function status(env: NodeJS.ProcessEnv): Promise<HostState> {
  const client = await connectHost({ env });
  if (!client) return { running: false };
  return stateOf(await client.call("host.hello", {}));
}

async function start(ctx: CliCommandContext): Promise<HostState & { launched: boolean }> {
  const self = selfCommand(ctx.runtime);
  const { client, launched } = await launchHost({
    env: ctx.runtime.env,
    launch: {
      command: self.command,
      args: [...self.args, "host", "run", ...idleArgs(parseIdleTimeout(ctx.args))],
      ...(self.env ? { env: self.env } : {}),
    },
  });
  return { ...stateOf(await client.call("host.hello", {})), launched };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host `record` names let the home go: its record is gone or replaced, or its process is. */
async function released(env: NodeJS.ProcessEnv, record: HostDiscoveryRecord): Promise<boolean> {
  if (!processAlive(record.pid)) return true;
  const current = await readHostRecord(env);
  return !current || current.instance_id !== record.instance_id;
}

async function waitForRelease(
  env: NodeJS.ProcessEnv,
  record: HostDiscoveryRecord,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await released(env, record))) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

/**
 * Stops the running host: `host.shutdown` first. A host that does not stop gets SIGTERM only when it
 * is its process's whole job; one a surface runs inside itself is never signalled, which would
 * quit that surface. Null when none ran.
 */
async function stop(env: NodeJS.ProcessEnv): Promise<{ pid: number; how: string } | null> {
  const record = await readHostRecord(env);
  if (!record || !processAlive(record.pid)) return null;
  let asked = false;
  try {
    const client = await connectHost({ env });
    if (client) {
      await client.call("host.shutdown", {});
      asked = true;
    }
  } catch {
    // A host that cannot answer (another RPC version, hung) is handled below.
  }
  if (asked && (await waitForRelease(env, record, STOP_WAIT_MS))) {
    return { pid: record.pid, how: "stopped" };
  }
  if (!record.standalone) {
    throw Object.assign(
      new Error(
        `the host runs inside another program (pid ${record.pid}, ${record.version}) and did not stop; quit that program to stop it`,
      ),
      { code: "host_did_not_stop" },
    );
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    return { pid: record.pid, how: "stopped" };
  }
  if (await waitForRelease(env, record, TERM_WAIT_MS)) {
    return { pid: record.pid, how: "terminated" };
  }
  throw Object.assign(new Error(`the host (pid ${record.pid}) did not stop`), {
    code: "host_did_not_stop",
  });
}

async function runHost(ctx: CliCommandContext): Promise<number> {
  const { runtime, mode } = ctx;
  const sub = ctx.args[0];
  try {
    switch (sub) {
      case "run": {
        const plugins = await cliHostPlugins();
        // A lease while the host serves: an update tells the person it keeps this version until it
        // stops, and no cleanup removes the capability files it loads.
        const host = capabilityHost();
        const release = registerRuntimeSession(runtime.env, {
          kind: "host",
          version: CLI_VERSION,
          ...(host?.home ? { capability_home: host.home } : {}),
        });
        // The host can run for hours: it keeps the release manifest on disk fresh, where checks run.
        const stopChecks = automaticChecksEnabled({
          env: runtime.env,
          install: thisInstall(runtime.env),
        })
          ? startPeriodicUpdateChecks({
              env: runtime.env,
              version: CLI_VERSION,
              fetchImpl: runtime.fetch,
            })
          : () => {};
        try {
          return await runHostProcess({
            env: runtime.env,
            version: `cli ${CLI_VERSION}`,
            plugins,
            idleTimeoutMs: parseIdleTimeout(ctx.args),
            log: (line) => runtime.stderr.write(`[pathrule-host] ${line}\n`),
          });
        } finally {
          stopChecks();
          release();
        }
      }
      case "start": {
        const state = await start(ctx);
        runtime.stdout.write(
          `${statusLabel("ok", mode)} ${state.launched ? "Started" : "Already running:"} the Pathrule host (pid ${state.pid}).\n`,
        );
        writeDetails(runtime, state);
        return 0;
      }
      case "status": {
        const state = await status(runtime.env);
        if (!state.running) {
          runtime.stdout.write(`${statusLabel("info", mode)} No Pathrule host is running.\n`);
          return 0;
        }
        runtime.stdout.write(
          `${statusLabel("ok", mode)} The Pathrule host is running (pid ${state.pid}, ${state.version}, since ${state.startedAt}).\n`,
        );
        writeDetails(runtime, state);
        return 0;
      }
      case "stop": {
        const stopped = await stop(runtime.env);
        runtime.stdout.write(
          stopped
            ? `${statusLabel("ok", mode)} The Pathrule host (pid ${stopped.pid}) ${stopped.how}.\n`
            : `${statusLabel("info", mode)} No Pathrule host is running.\n`,
        );
        return 0;
      }
      default:
        runtime.stderr.write(`${USAGE}\n`);
        return 64;
    }
  } catch (err) {
    runtime.stderr.write(`${statusLabel("error", mode)} ${explain(err, runtime)}\n`);
    return failureExit(err);
  }
}

function writeDetails(runtime: CliRuntime, state: HostState): void {
  for (const plugin of state.plugins ?? []) {
    runtime.stdout.write(
      `  plugin ${plugin.name}: ${plugin.state}${plugin.reason ? ` (${plugin.reason})` : ""}\n`,
    );
  }
  if (state.idle) {
    const minutes = state.idle.timeoutMs / 60_000;
    runtime.stdout.write(
      state.idle.heldBy.length > 0
        ? `  kept running by: ${state.idle.heldBy.join("; ")}\n`
        : `  stops after ${minutes} min without a request\n`,
    );
  }
}

function explain(err: unknown, runtime: CliRuntime): string {
  if (err instanceof HostLaunchError) {
    return `${err.message.split("\n")[0]}. The host's log: ${hostLogFile(runtime.env)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function codeOf(err: unknown): string {
  if (err instanceof HostLaunchError) return "host_launch_failed";
  if (err instanceof HostClientError) return `host_${err.code}`;
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return "host_failed";
}

function failureExit(err: unknown): number {
  return codeOf(err) === "invalid_idle_timeout" ? 64 : 1;
}

async function hostJson(ctx: CliCommandContext): Promise<CliJsonResult> {
  const { runtime } = ctx;
  const sub = ctx.args[0];
  const command = `host${sub ? ` ${sub}` : ""}`;
  const fail = (code: string, message: string, exitCode: number): CliJsonResult => ({
    exitCode,
    envelope: jsonEnvelope({ command, cwd: runtime.cwd, ok: false, error: { code, message } }),
  });
  const ok = (data: unknown): CliJsonResult => ({
    exitCode: 0,
    envelope: jsonEnvelope({ command, cwd: runtime.cwd, ok: true, data }),
  });
  try {
    switch (sub) {
      case "start":
        return ok(await start(ctx));
      case "status":
        return ok(await status(runtime.env));
      case "stop": {
        const stopped = await stop(runtime.env);
        return ok(stopped ? { running: false, ...stopped } : { running: false, how: "none" });
      }
      case "run":
        return fail("json_not_supported", "`pathrule host run` serves in the foreground", 64);
      default:
        return fail("invalid_host_command", USAGE, 64);
    }
  } catch (err) {
    return fail(codeOf(err), explain(err, runtime), failureExit(err));
  }
}
