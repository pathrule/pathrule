// SPDX-License-Identifier: Apache-2.0
//
// One latency budget for project learning, shared by the host's turn context and the MCP
// get_context tool.
//
// Learning claims are checked against the working tree and the source map runs a git
// status plus bounded hashing, so on a large checkout the pair can take seconds. Neither
// caller may wait that long: each races the load against a budget, proceeds without it
// on timeout, and lets the load finish in the background so the next call can use it.
//
// The stamp (see learning-stamp.ts) is part of every key, so a recorded, revised or
// retracted claim is never served from an older load.

import type { LearningClaim } from "./claims.js";
import type { ProjectMapContext } from "@pathrule/protocol/project-learning-types.js";

export interface BudgetedLoader<T> {
  /** The value, or null when the load missed `budgetMs`. Never throws. */
  load(key: string, stamp: string, run: () => Promise<T>, budgetMs: number): Promise<T | null>;
  clear(): void;
}

/**
 * `ttlMs > 0`: a finished value serves the same key and stamp until it expires, which
 * bounds how long a source edit can go unnoticed.
 * `ttlMs === 0`: nothing is reused except a load that missed its budget, which is handed
 * once to the next call (within a minute) instead of being thrown away.
 */
export function createBudgetedLoader<T>(ttlMs: number): BudgetedLoader<T> {
  const done = new Map<string, { stamp: string; expires: number; value: T }>();
  const running = new Map<string, Promise<T>>();
  return {
    async load(key, stamp, run, budgetMs) {
      const hit = done.get(key);
      if (hit && hit.stamp === stamp && hit.expires > Date.now()) {
        if (ttlMs === 0) done.delete(key);
        return hit.value;
      }
      const jobKey = `${key}::${stamp}`;
      let missed = false;
      let job = running.get(jobKey);
      if (!job) {
        const started = run().then((value) => {
          if (ttlMs > 0 || missed)
            done.set(key, { stamp, expires: Date.now() + (ttlMs || 60_000), value });
          return value;
        });
        job = started;
        running.set(jobKey, started);
        void started
          .finally(() => {
            if (running.get(jobKey) === started) running.delete(jobKey);
          })
          .catch(() => {});
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          missed = true;
          resolve(null);
        }, budgetMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([job, timeout]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    clear() {
      done.clear();
      running.clear();
    },
  };
}

/**
 * Drop review targets already covered by a reviewed claim citing the same bytes. Applied
 * after the fact because the map now loads beside the claims instead of after them.
 */
export function excludeVerifiedTargets(
  map: ProjectMapContext,
  claims: readonly LearningClaim[],
): ProjectMapContext {
  const verified = new Set(
    claims.flatMap((claim) => claim.sources.map((source) => `${source.path}:${source.digest}`)),
  );
  return {
    ...map,
    reviewTargets: map.reviewTargets?.filter(
      (target) => !verified.has(`${target.path}:${target.digest}`),
    ),
  };
}
