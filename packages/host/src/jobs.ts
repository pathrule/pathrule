// SPDX-License-Identifier: Apache-2.0
/**
 * The host's background jobs (open-core step 4h4): local file work that only Studio started before,
 * so that removing Studio loses none of it. A host runs them when it is its process's whole job
 * (`standalone`: the host the CLI, the MCP server, VS Code or the daemon launched). Studio, until it
 * is removed, starts the same functions itself.
 *
 * - **Hook file rotation.** The hook appends `<home>/logs/hooks-<day>.log` on every call and keeps
 *   a dedup ledger `<home>/cache/<workspace>/session-<id>.json` per agent session, which its Stop
 *   hook normally deletes. Logs older than 7 days and ledgers older than 24 hours are removed, at
 *   start and then daily.
 * - **Failure-pattern promotion** (./learning/fail-patterns.ts), at start and every 5 minutes.
 *
 * The timers never keep the host running, and they stop with it.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";

import { startFailPatternDetector } from "./learning/fail-patterns.js";

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Files removed by one rotation. */
export interface HookFileRotation {
  logs: number;
  sessions: number;
}

/** Remove the files under `dir` named by `matches` that were last written before `cutoff`. */
async function reap(dir: string, matches: (name: string) => boolean, cutoff: number) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!matches(name)) continue;
    const target = join(dir, name);
    try {
      if ((await stat(target)).mtimeMs < cutoff) {
        await unlink(target);
        removed += 1;
      }
    } catch {
      // Another rotation, or the hook's Stop, removed it first.
    }
  }
  return removed;
}

/** One rotation of the hook's logs and session ledgers in the Pathrule home. Never throws. */
export async function rotateHookFiles(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<HookFileRotation> {
  const home = pathruleHome(env);
  const logs = await reap(
    join(home, "logs"),
    (name) => name.startsWith("hooks-") && name.endsWith(".log"),
    now - LOG_RETENTION_MS,
  );
  let sessions = 0;
  const cache = join(home, "cache");
  let workspaces: string[] = [];
  try {
    workspaces = await readdir(cache);
  } catch {
    // No cache yet: nothing to rotate.
  }
  for (const workspace of workspaces) {
    sessions += await reap(
      join(cache, workspace),
      (name) => name.startsWith("session-") && name.endsWith(".json"),
      now - SESSION_RETENTION_MS,
    );
  }
  return { logs, sessions };
}

/** Rotate now and then daily, for the life of the process. Returns a function that stops it. */
export function startHookFileRotation(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): () => void {
  const run = () =>
    void rotateHookFiles(env).then(({ logs, sessions }) => {
      if (logs + sessions > 0) {
        log(`[hook-files] rotated ${logs} log file(s), ${sessions} session ledger(s)`);
      }
    });
  run();
  const timer = setInterval(run, ROTATE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Start the host's background jobs; the returned function stops them. */
export function startHostJobs(env: NodeJS.ProcessEnv, log: (line: string) => void): () => void {
  const stops = [startHookFileRotation(env, log), startFailPatternDetector({ env })];
  return () => {
    for (const stop of stops) stop();
  };
}
