// SPDX-License-Identifier: Apache-2.0
// One shared atomic-write/read pair for the local runtime, so the CLI's
// install/sync/hook-script writers don't each re-declare it (they previously had
// byte-identical private copies). Tmp files use a per-process, per-call unique
// suffix so two concurrent writers to the same target can't clobber a shared
// `${target}.tmp` mid-write; the rename itself is atomic.
//
// The shared-tmp failure is not hypothetical. Two writers that open the same
// `${target}.tmp` with O_TRUNC write over each other, the shorter body lands on
// top of the longer one's tail, and the first rename publishes the result: valid
// JSON followed by a few leftover bytes. That is how Studio's parallel MCP probes
// made Claude Code report ~/.claude.json as corrupted.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

let tmpCounter = 0;

export interface AtomicWriteOptions {
  /** Permission bits applied to the temp file before it is renamed into place,
   *  so the target is never visible with default permissions. */
  mode?: number;
}

export async function atomicWrite(
  target: string,
  body: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  // Unique per process and per call: never a fixed `${target}.tmp` two writers share.
  const tmp = `${target}.${process.pid}.${(tmpCounter += 1)}.tmp`;
  try {
    await writeFile(tmp, body, "utf8");
    if (opts.mode !== undefined) await chmod(tmp, opts.mode);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // best-effort temp cleanup
    throw err;
  }
}

const fileQueues = new Map<string, Promise<void>>();

/**
 * Run `run` as the only queued update of `target` in this process.
 *
 * An atomic rename keeps a reader from ever seeing a torn file, but two
 * read-modify-write passes that read the same bytes still drop one another's
 * change: the last rename wins. Wrapping the read, the transform and the write
 * in one queued step closes that within a process. It does not coordinate with
 * other processes, which is why the write itself must still be atomic.
 *
 * Never call it for the same target from inside `run`: the inner call waits for
 * the outer one and neither finishes.
 */
export function serializeByPath<T>(target: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(target);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(key, tail);
  void tail.then(() => {
    if (fileQueues.get(key) === tail) fileQueues.delete(key);
  });
  return next;
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
