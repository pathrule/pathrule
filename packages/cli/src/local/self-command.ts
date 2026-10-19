// SPDX-License-Identifier: Apache-2.0
/**
 * How this CLI runs itself as another process, and so how it launches the home's Pathrule host
 * (./host-session.ts). The binary says it from `main`; VS Code says it at activation, with its
 * bundled CLI under Electron as Node. Kept apart from the session, which loads the store's code:
 * an extension activating, or an MCP server starting, must not load SQLite before it needs it.
 */
import type { HostLaunchCommand } from "@pathrule/host/launch.js";

export const LAUNCHED_HOST_IDLE_MINUTES = 10;

/** How this CLI runs itself as another process: the program and the arguments before a command. */
export interface CliSelfCommand {
  command: string;
  args: string[];
  /** Added to the environment of the processes it starts (Electron as Node, a native binding). */
  env?: NodeJS.ProcessEnv;
}

let self: CliSelfCommand | null = null;

export function setCliSelfCommand(next: CliSelfCommand | null): void {
  self = next;
}

export function cliSelfCommand(): CliSelfCommand | null {
  return self;
}

/**
 * This process's Node and entry, as the binary runs them. Debugger flags are left out: a second
 * process would fight over the inspector's port.
 */
export function selfCommandOf(entry: string | undefined): CliSelfCommand | null {
  if (!entry) return null;
  const execArgv = process.execArgv.filter((arg) => !/^--(inspect|debug)/.test(arg));
  return { command: process.execPath, args: [...execArgv, entry] };
}

/** How this CLI launches the home's host, or null when nothing said how (a library use). */
export function cliHostLaunch(): HostLaunchCommand | null {
  return self
    ? {
        command: self.command,
        args: [...self.args, "host", "run", "--idle-timeout", String(LAUNCHED_HOST_IDLE_MINUTES)],
        ...(self.env ? { env: self.env } : {}),
      }
    : null;
}
