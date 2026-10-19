// SPDX-License-Identifier: Apache-2.0

import { allowedProjectPath } from "./capture.js";
import type { ProjectMapSnapshot, SourceReviewTarget } from "@pathrule/protocol/project-learning-types.js";

export const MAX_REVIEW_TARGETS = 200;

export function validReviewTarget(raw: SourceReviewTarget): boolean {
  return (
    !!raw &&
    typeof raw.path === "string" &&
    allowedProjectPath(raw.path) &&
    ["initial", "added", "changed", "removed"].includes(raw.reason) &&
    (raw.reason === "removed"
      ? raw.digest === undefined
      : typeof raw.digest === "string" &&
        /^(?:git:(?:[a-f0-9]{40}|[a-f0-9]{64})|sha256:[a-f0-9]{64})$/.test(raw.digest))
  );
}

/** Keep unreviewed observations when HEAD is unchanged. A scan is not an acknowledgement.
 * New deltas lead the bounded backlog; incomplete scans cannot infer deletion. */
export function retainReviewTargets(
  current: ProjectMapSnapshot,
  previous?: ProjectMapSnapshot,
): Pick<ProjectMapSnapshot, "reviewTargets" | "reviewTargetsTruncated"> {
  const old = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  const files = new Map(current.files.map((file) => [file.path, file]));
  const targets = new Map<string, SourceReviewTarget>();
  for (const file of current.files) {
    if (!file.digest) continue;
    const prior = old.get(file.path);
    if (prior?.digest === file.digest) continue;
    targets.set(file.path, {
      path: file.path,
      digest: file.digest,
      reason: !previous ? "initial" : prior ? "changed" : "added",
    });
  }
  if (current.coverage.inventoryComplete && current.consistency === "stable") {
    for (const path of old.keys())
      if (!files.has(path)) targets.set(path, { path, reason: "removed" });
  }
  for (const target of previous?.reviewTargets ?? []) {
    if (targets.has(target.path) || !validReviewTarget(target)) continue;
    const file = files.get(target.path);
    if (file?.digest)
      targets.set(target.path, {
        ...target,
        digest: file.digest,
        reason: target.reason === "removed" ? "added" : target.reason,
      });
    else if (!file) targets.set(target.path, target);
  }
  const ranked = [...targets.values()].sort((a, b) => {
    // A newly observed delta must not be starved behind the cold-start inventory.
    const priority = (t: SourceReviewTarget) => (t.reason === "initial" ? 1 : 0);
    return priority(a) - priority(b);
  });
  return {
    reviewTargets: ranked.slice(0, MAX_REVIEW_TARGETS),
    reviewTargetsTruncated:
      ranked.length > MAX_REVIEW_TARGETS || previous?.reviewTargetsTruncated === true,
  };
}
