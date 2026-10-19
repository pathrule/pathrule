// SPDX-License-Identifier: Apache-2.0
/**
 * The host as a process: start it, stop it on SIGTERM or SIGINT, and return an exit code. A
 * launcher (the CLI) runs this in a process of its own and reads the discovery record to
 * reach it.
 *
 * A process killed without a chance to stop (SIGKILL, a crash) leaves its record behind; the next
 * host finds the process gone and takes the home over (./discovery.ts).
 */
import { HostAlreadyRunningError } from "./discovery.js";
import { startHost, type HostOptions } from "./host.js";

export const HOST_EXIT = {
  /** Stopped cleanly. */
  stopped: 0,
  /** Could not start. */
  failed: 1,
  /** Another live host holds this Pathrule home; this one never started. */
  alreadyRunning: 2,
} as const;

export interface HostProcessOptions extends HostOptions {
  /** Where SIGTERM and SIGINT arrive. Defaults to `process`. */
  signals?: Pick<NodeJS.Process, "once" | "off">;
  /** Stops the host when it aborts: for a composition whose own work ends the process. */
  stopSignal?: AbortSignal;
}

export async function runHostProcess(options: HostProcessOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`[pathrule-host] ${line}\n`));
  let host;
  try {
    host = await startHost({ ...options, log, standalone: true });
  } catch (err) {
    log(`could not start: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof HostAlreadyRunningError ? HOST_EXIT.alreadyRunning : HOST_EXIT.failed;
  }
  const signals = options.signals ?? process;
  const onSignal = (signal: NodeJS.Signals) => {
    void host.stop(signal);
  };
  const onAbort = () => void host.stop("stop signal");
  signals.once("SIGTERM", onSignal);
  signals.once("SIGINT", onSignal);
  if (options.stopSignal?.aborted) onAbort();
  else options.stopSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    await host.stopped;
  } finally {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
    options.stopSignal?.removeEventListener("abort", onAbort);
  }
  return HOST_EXIT.stopped;
}
