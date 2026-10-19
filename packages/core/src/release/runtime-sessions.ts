// SPDX-License-Identifier: Apache-2.0
/**
 * Which Pathrule processes are running right now, so an update can say who keeps the old version
 * and a cleanup never removes files a running process still loads.
 *
 * A long-running process (an MCP server an agent started, the host) writes a lease at
 * `<PATHRULE_HOME>/updates/sessions/<pid>-<kind>.json` and removes it when it exits. A lease whose
 * process is gone (a crash, a kill) is ignored and removed by the next reader. Nothing here stops,
 * signals or restarts a process: an update never interrupts a running session.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PATHRULE_DIR_MODE, PATHRULE_FILE_MODE } from "../storage/paths.js";
import { updatesDir } from "./update-state.js";

export type RuntimeSessionKind = "mcp" | "host";

export interface RuntimeSessionLease {
  pid: number;
  kind: RuntimeSessionKind;
  /** The CLI version the process runs. */
  version: string;
  started_at: string;
  /** The capability home whose modules the process loads, when it has one. */
  capability_home?: string;
  /** The agent plugin that launched it (`PATHRULE_PLUGIN_VERSION`), when one did. */
  plugin_version?: string;
}

function sessionsDir(env: NodeJS.ProcessEnv): string {
  return join(updatesDir(env), "sessions");
}

function leasePath(env: NodeJS.ProcessEnv, pid: number, kind: RuntimeSessionKind): string {
  return join(sessionsDir(env), `${pid}-${kind}.json`);
}

/** Whether a process id is alive. A process this user may not signal is alive. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Record this process as running. Returns the release, also run when the process exits. Best
 * effort: a home that cannot be written leaves the process unrecorded, never stopped.
 */
export function registerRuntimeSession(
  env: NodeJS.ProcessEnv,
  lease: Omit<RuntimeSessionLease, "pid" | "started_at">,
): () => void {
  const path = leasePath(env, process.pid, lease.kind);
  const release = () => {
    rmSync(path, { force: true });
    process.off("exit", release);
  };
  try {
    mkdirSync(sessionsDir(env), { recursive: true, mode: PATHRULE_DIR_MODE });
    const record: RuntimeSessionLease = {
      ...lease,
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: PATHRULE_FILE_MODE });
    process.once("exit", release);
  } catch {
    return () => {};
  }
  return release;
}

/** The running sessions, other than the caller's own process. Removes leases of exited processes. */
export function activeRuntimeSessions(
  env: NodeJS.ProcessEnv = process.env,
  alive: (pid: number) => boolean = processAlive,
): RuntimeSessionLease[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(env));
  } catch {
    return [];
  }
  const out: RuntimeSessionLease[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(sessionsDir(env), name);
    let lease: RuntimeSessionLease;
    try {
      lease = JSON.parse(readFileSync(path, "utf8")) as RuntimeSessionLease;
    } catch {
      continue;
    }
    if (typeof lease?.pid !== "number" || typeof lease.version !== "string") continue;
    if (lease.pid === process.pid) continue;
    if (!alive(lease.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    out.push(lease);
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
