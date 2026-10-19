// SPDX-License-Identifier: Apache-2.0
/**
 * How the CLI reaches its local stores: through the Pathrule host of its home
 * (`@pathrule/host/session.js`), the stores' one owner (open-core step 4h3).
 *
 * - **The binary says how to launch the host** (`setCliSelfCommand`, from `main`; VS Code with its
 *   bundled CLI). A host a command launches is a process of its own: it outlives the command and
 *   stops after `LAUNCHED_HOST_IDLE_MINUTES` without a request, so the next command, the MCP server
 *   or VS Code finds it running.
 * - **Run as a library** (tests, a composition that said nothing), a command runs the host in its
 *   own process for the length of the call. That host gets no plugins: this process installed the
 *   engine already (the CLI's plugins), and Cloud's daemon job never runs inside a command.
 */
import { HostSession } from "@pathrule/host/session.js";

import { CLI_VERSION } from "../cli-version.js";
import { cliHostLaunch } from "./self-command.js";

export {
  cliHostLaunch,
  cliSelfCommand,
  LAUNCHED_HOST_IDLE_MINUTES,
  selfCommandOf,
  setCliSelfCommand,
  type CliSelfCommand,
} from "./self-command.js";

/** A host session for one use of the stores; close it when done. */
export function cliHostSession(env: NodeJS.ProcessEnv): HostSession {
  return new HostSession({ env, launch: cliHostLaunch(), version: `cli ${CLI_VERSION}` });
}

/** Runs `fn` with a host session that closes after it. */
export async function withCliHostSession<T>(
  env: NodeJS.ProcessEnv,
  fn: (session: HostSession) => Promise<T>,
): Promise<T> {
  const session = cliHostSession(env);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
