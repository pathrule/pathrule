// SPDX-License-Identifier: Apache-2.0
//
// Hot paths from `git log`: the most-changed files of the last days, counted from the
// file list git prints. The caller runs git and passes its stdout.

import type { HotPath } from "@pathrule/protocol/intelligence-types.js";

/** How many hot paths a briefing carries. */
export const HOT_PATHS_LIMIT = 5;

/**
 * Parse `git log` output into hot paths. Used as a day-one fallback
 * when change_log is empty. The caller is responsible for running
 * the git command and passing stdout here.
 *
 * Expected input: output of `git log --since="7 days ago" --name-only --pretty=format:""`
 */
export function parseGitLogHotPaths(gitLogOutput: string): HotPath[] {
  const counts = new Map<string, number>();

  for (const line of gitLogOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOT_PATHS_LIMIT)
    .map(([path, change_count]) => ({ path, change_count }));
}
