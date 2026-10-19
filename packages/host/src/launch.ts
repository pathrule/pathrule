// SPDX-License-Identifier: Apache-2.0
/**
 * Launching the host of a Pathrule home as a process of its own, for the surfaces that need one:
 * connect to the running host, or start `launch.command launch.args` detached and wait until it
 * answers. The command is the surface's own way to run `runHostProcess` (the CLI's `pathrule host
 * run`), so the launched host loads the plugins that surface has.
 *
 * - **One host per home.** Two surfaces launching at once both start a process; one claims the home
 *   and the other exits with `HOST_EXIT.alreadyRunning`, and both surfaces reach the one that won.
 * - **It outlives the launcher.** The process is detached, so it keeps serving after the surface
 *   that started it exits. It stops by itself when it was started with an idle timeout.
 * - **Its output** goes to `<Pathrule home>/host/host.log`, which a launch that fails quotes.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { connectHost, HostClientError, type HostClient } from "./client.js";
import { hostDir } from "./discovery.js";
import { HOST_EXIT } from "./process.js";

/** How a surface runs the host: a program and its arguments. */
export interface HostLaunchCommand {
  command: string;
  args: readonly string[];
  /** Added to the launcher's environment. */
  env?: NodeJS.ProcessEnv;
}

export interface LaunchHostOptions {
  env?: NodeJS.ProcessEnv;
  launch: HostLaunchCommand;
  /** How long to wait for the launched host to answer (plugins activate before it does). */
  waitMs?: number;
  log?(line: string): void;
}

export interface LaunchedHost {
  client: HostClient;
  /** True when this call started the process; false when a host was already running. */
  launched: boolean;
}

export class HostLaunchError extends Error {
  constructor(
    message: string,
    /** The end of the host's log, when it wrote one. */
    readonly logTail: string,
  ) {
    super(logTail ? `${message}\n${logTail}` : message);
    this.name = "HostLaunchError";
  }
}

const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 50;
/** The log is started over beyond this size, keeping one previous file. */
const LOG_LIMIT_BYTES = 1024 * 1024;
const LOG_TAIL_LINES = 20;

export function hostLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "host.log");
}

function openLog(env: NodeJS.ProcessEnv): number {
  mkdirSync(hostDir(env), { recursive: true, mode: 0o700 });
  const file = hostLogFile(env);
  try {
    if (statSync(file).size > LOG_LIMIT_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  return openSync(file, "a", 0o600);
}

function logTail(env: NodeJS.ProcessEnv): string {
  try {
    const lines = readFileSync(hostLogFile(env), "utf8").trimEnd().split("\n");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The running host if it answers now; null while none is running or ready. */
async function tryConnect(env: NodeJS.ProcessEnv): Promise<HostClient | null> {
  try {
    return await connectHost({ env });
  } catch (err) {
    // A host of another RPC version will not become usable by waiting.
    if (err instanceof HostClientError && err.code === "rpc_version_mismatch") throw err;
    return null;
  }
}

/**
 * The home's running host, launched first when none is. Throws `HostLaunchError` when the launched
 * process fails or does not answer in time, and the client's error when a host of another RPC
 * version holds the home.
 */
export async function launchHost(options: LaunchHostOptions): Promise<LaunchedHost> {
  const env = options.env ?? process.env;
  const running = await tryConnect(env);
  if (running) return { client: running, launched: false };

  const fd = openLog(env);
  let exitCode: number | null | undefined;
  let spawnError: Error | null = null;
  try {
    const child = spawn(options.launch.command, [...options.launch.args], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, ...options.launch.env },
      windowsHide: true,
    });
    child.once("error", (err) => (spawnError = err));
    child.once("exit", (code) => (exitCode = code));
    child.unref();
    options.log?.(`launched the host (pid ${child.pid ?? "unknown"})`);
  } finally {
    // The child holds its own copy of the descriptor.
    closeSync(fd);
  }

  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const client = await tryConnect(env);
    if (client) return { client, launched: true };
    if (spawnError) {
      throw new HostLaunchError(
        `could not start the host: ${(spawnError as Error).message}`,
        logTail(env),
      );
    }
    // Another launcher's host won the home: keep waiting for it to answer.
    if (exitCode !== undefined && exitCode !== HOST_EXIT.alreadyRunning) {
      throw new HostLaunchError(`the host exited with code ${exitCode}`, logTail(env));
    }
    if (Date.now() >= deadline) {
      throw new HostLaunchError(
        `the host did not answer within ${options.waitMs ?? DEFAULT_WAIT_MS} ms`,
        logTail(env),
      );
    }
    await sleep(POLL_MS);
  }
}
