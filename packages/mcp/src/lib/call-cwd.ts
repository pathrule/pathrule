// SPDX-License-Identifier: Apache-2.0
// The working directory of the tool call being served.
//
// A stdio MCP server is spawned once per agent session, and the process's own cwd is wherever the
// client started it: a provider plugin's server can start outside the project. The call's `cwd`
// argument is the agent's real location, so the local runtime resolves the workspace from it, and
// falls back to the process cwd only when a call carries none.
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";

const storage = new AsyncLocalStorage<string>();

export function runWithCallCwd<T>(args: unknown, run: () => Promise<T>): Promise<T> {
  const cwd = (args as { cwd?: unknown } | null)?.cwd;
  if (typeof cwd === "string" && cwd.trim() !== "" && isAbsolute(cwd.trim())) {
    return storage.run(cwd.trim(), run);
  }
  return run();
}

/** The current call's absolute cwd argument, or null when it gave none. */
export function callCwd(): string | null {
  return storage.getStore() ?? null;
}
