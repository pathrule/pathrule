// SPDX-License-Identifier: Apache-2.0
/**
 * The host's discovery record: `<Pathrule home>/host/host.json`, 0600 in a 0700 directory. It is
 * how a client finds the running host, and it is the claim that makes the host the only one of its
 * Pathrule home.
 *
 * - **Claiming** happens under a short file lock, so two hosts starting at once cannot both win.
 *   A record whose process is alive refuses the newcomer; one whose process is gone (a crash) is
 *   replaced.
 * - **Writing** is atomic: a unique temporary file, given 0600 first, renamed into place.
 * - **Releasing** removes the record only while it is still this instance's, so a host that stops
 *   late never deletes the record of the host that replaced it.
 *
 * Liveness is the pid. A pid that the system reused for an unrelated process after a crash reads
 * as a live host; the newcomer is then refused with that pid named, and never takes over a home a
 * live host may still be writing.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import { withFileLock } from "@pathrule/core/storage/file-lock.js";
import { PATHRULE_FILE_MODE, pathruleHome } from "@pathrule/core/storage/paths.js";
import type { HostDiscoveryRecord } from "@pathrule/protocol/host-rpc.js";

/** The claim's critical section takes milliseconds; a lock this old belongs to a process that died. */
const CLAIM_LOCK = { timeoutMs: 10_000, staleMs: 10_000 } as const;

export function hostDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "host");
}

export function hostRecordFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(hostDir(env), "host.json");
}

function claimLockFile(env: NodeJS.ProcessEnv): string {
  return join(hostDir(env), "host.json.lock");
}

/** A live process with this pid exists (one owned by another user counts). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isRecord(value: unknown): value is HostDiscoveryRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.schema_version === 1 &&
    typeof r.rpc === "number" &&
    Number.isInteger(r.pid) &&
    Number.isInteger(r.port) &&
    typeof r.token === "string" &&
    r.token.length > 0 &&
    typeof r.version === "string" &&
    typeof r.instance_id === "string" &&
    typeof r.started_at === "string"
  );
}

/** The published record, or null when there is none or it is unreadable. */
export async function readHostRecord(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostDiscoveryRecord | null> {
  let text: string;
  try {
    text = await readFile(hostRecordFile(env), "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export class HostAlreadyRunningError extends Error {
  readonly pid: number;
  readonly port: number;

  constructor(record: HostDiscoveryRecord) {
    super(
      `A Pathrule host is already running for this Pathrule home (pid ${record.pid}, port ${record.port}).`,
    );
    this.name = "HostAlreadyRunningError";
    this.pid = record.pid;
    this.port = record.port;
  }
}

/** Publish `record`, unless a live host already holds the home. */
export async function claimHostRecord(
  env: NodeJS.ProcessEnv,
  record: HostDiscoveryRecord,
): Promise<void> {
  await withFileLock(
    claimLockFile(env),
    async () => {
      const current = await readHostRecord(env);
      if (current && processAlive(current.pid)) throw new HostAlreadyRunningError(current);
      await atomicWrite(hostRecordFile(env), `${JSON.stringify(record, null, 2)}\n`, {
        mode: PATHRULE_FILE_MODE,
      });
    },
    CLAIM_LOCK,
  );
}

/** Remove the record if it is still `instanceId`'s. True when it was removed. */
export async function releaseHostRecord(
  env: NodeJS.ProcessEnv,
  instanceId: string,
): Promise<boolean> {
  return withFileLock(
    claimLockFile(env),
    async () => {
      const current = await readHostRecord(env);
      if (current?.instance_id !== instanceId) return false;
      await rm(hostRecordFile(env), { force: true });
      return true;
    },
    CLAIM_LOCK,
  );
}
