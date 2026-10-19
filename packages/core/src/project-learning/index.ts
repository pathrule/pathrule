// SPDX-License-Identifier: Apache-2.0

import { realpath } from "node:fs/promises";
import { retainReviewTargets } from "./review-targets.js";
import { captureProjectMap, rootKey } from "./capture.js";
import { projectMapContext } from "./context.js";
import { loadProjectMap, projectMapPath, saveProjectMap } from "./store.js";
import type { ProjectMapContext, ProjectMapOptions, ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";

export type { ProjectMapContext, ProjectMapOptions, ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";
export { projectMapPath } from "./store.js";
export { createBudgetedLoader, excludeVerifiedTargets, type BudgetedLoader } from "./budget.js";
export { noteLearningChanged, readLearningStamp } from "./learning-stamp.js";

// One bounded capture per workspace/root in this process. No watcher or model worker.
const running = new Map<string, Promise<{ snapshot: ProjectMapSnapshot; persisted: boolean }>>();
export async function refreshProjectMap(options: ProjectMapOptions): Promise<ProjectMapContext> {
  try {
    const root = await realpath(options.localRootPath);
    const destination = await projectMapPath(
      options.workspaceId,
      root,
      options.env ?? process.env,
    ).catch(() => null);
    const key = JSON.stringify([
      options.workspaceId,
      root,
      destination,
      options.maxFiles,
      options.maxReadBytes,
      options.timeoutMs,
    ]);
    let job = running.get(key);
    if (!job) {
      job = (async () => {
        const previous = await loadProjectMap(destination, rootKey(root));
        const snapshot = await captureProjectMap({ ...options, localRootPath: root }, previous);
        Object.assign(snapshot, retainReviewTargets(snapshot, previous));
        // An interrupted inventory must not replace a complete prior checkpoint.
        const persisted =
          snapshot.consistency === "stable" &&
          snapshot.coverage.inventoryComplete &&
          snapshot.coverage.unavailableFiles === 0
            ? await saveProjectMap(destination, snapshot)
            : false;
        return { snapshot, persisted };
      })();
      running.set(key, job);
      void job
        .finally(() => {
          if (running.get(key) === job) running.delete(key);
        })
        .catch(() => {});
    }
    const { snapshot, persisted } = await job;
    return projectMapContext(snapshot, options.scope, persisted, options.verifiedSources);
  } catch {
    return projectMapContext(undefined);
  }
}
