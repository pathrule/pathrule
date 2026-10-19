// SPDX-License-Identifier: Apache-2.0
/**
 * The small JSON files User Intelligence keeps next to the knowledge store: behaviour tallies, pending
 * edit episodes, the oversight map and expertise leases. One way to read and write them, so every file
 * is 0600, written atomically, and never read-modify-written by two turns at once.
 */
import { chmod, readFile } from "node:fs/promises";
import { atomicWrite } from "../storage/atomic-write.js";
import { PATHRULE_FILE_MODE } from "../storage/paths.js";

/** The parsed file, or null when it is missing or unreadable. A broken file reads as an empty one. */
export async function readPrivateJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2));
  try { await chmod(path, PATHRULE_FILE_MODE); } catch { /* best effort */ }
}

/**
 * One writer at a time per file inside this process. The host is the usual writer, but two
 * turns can finish together, and a read-modify-write race would silently drop an observation.
 */
const queues = new Map<string, Promise<unknown>>();
export function serializedWrite<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(run, run);
  queues.set(path, next.catch(() => {}));
  return next;
}
