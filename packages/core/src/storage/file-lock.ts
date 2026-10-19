// SPDX-License-Identifier: Apache-2.0
//
// A cross-process lock on one file: create it exclusively (0600, in a 0700 directory),
// run the work, delete it. A lock older than `staleMs` belongs to a process that died
// mid-work and is broken; a waiter polls until `timeoutMs` and then gives up.

import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 45_000;
const POLL_MS = 100;

export class FileLockTimeoutError extends Error {
  constructor(lockFile: string) {
    super(`file_lock_timeout: ${lockFile}`);
    this.name = "FileLockTimeoutError";
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** The error a waiter throws when the deadline passes. Defaults to `FileLockTimeoutError`. */
  onTimeout?: () => Error;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireLockFile(lockFile: string): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(lockFile), 0o700).catch(() => {});
    const handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(`${process.pid}:${Date.now()}\n`, "utf8");
    await handle.close();

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await rm(lockFile, { force: true }).catch(() => {});
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

async function breakStaleLock(lockFile: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockFile);
    if (Date.now() - info.mtimeMs > staleMs) {
      await rm(lockFile, { force: true });
    }
  } catch {
    // Best-effort. A concurrent release or missing file is fine.
  }
}

/** Run `fn` while holding `lockFile`. */
export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const release = await tryAcquireLockFile(lockFile);
    if (release) {
      try {
        return await fn();
      } finally {
        await release();
      }
    }

    await breakStaleLock(lockFile, staleMs);
    await sleep(POLL_MS);
  }

  throw opts.onTimeout ? opts.onTimeout() : new FileLockTimeoutError(lockFile);
}
