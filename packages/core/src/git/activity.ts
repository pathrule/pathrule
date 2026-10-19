// SPDX-License-Identifier: Apache-2.0
// Which files changed in which commits over the coverage window. Node-only
// (child_process), so it has its own subpath and is never re-exported from an index a
// renderer may load. Reads commit metadata only, never file contents, and returns [] outside
// a git checkout or on any failure: a gap detector that cannot read history reports nothing
// rather than everything. A Git read, so it is open (the host's workspace reads use it); the
// engine's turn-context gaps call it too.

import { execFile } from "node:child_process";
import { COVERAGE_WINDOW_DAYS } from "@pathrule/protocol/knowledge-gap.js";
import type { GitCommitActivity } from "@pathrule/protocol/workspace-read.js";

export const GIT_ACTIVITY_MAX_COMMITS = 2_000;
export const GIT_ACTIVITY_MAX_PATHS = 100_000;
const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MARK = "@@pathrule-commit@@";

export type GitLogRunner = (root: string, args: readonly string[]) => Promise<string>;

const defaultRunner: GitLogRunner = (root, args) =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** Parse `git log --format=<MARK>%ct --name-only` output. Exported for tests. */
export function parseGitActivity(output: string): GitCommitActivity[] {
  const commits: GitCommitActivity[] = [];
  let current: GitCommitActivity | null = null;
  let paths = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith(MARK)) {
      const committedAt = Number(line.slice(MARK.length).trim());
      current = Number.isFinite(committedAt) ? { committedAt, paths: [] } : null;
      if (current) commits.push(current);
      continue;
    }
    const path = line.trim();
    if (!current || !path || paths >= GIT_ACTIVITY_MAX_PATHS) continue;
    current.paths.push(path);
    paths++;
  }
  return commits;
}

/** The checked-out commit, or null outside a checkout. About 10ms, so callers key caches on it. */
export async function readGitHead(workspaceRoot: string, run: GitLogRunner = defaultRunner): Promise<string | null> {
  try {
    return (await run(workspaceRoot, ["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export async function readGitActivity(
  workspaceRoot: string,
  windowDays = COVERAGE_WINDOW_DAYS,
  run: GitLogRunner = defaultRunner,
): Promise<GitCommitActivity[]> {
  try {
    const output = await run(workspaceRoot, [
      "-c",
      "core.quotePath=false",
      "log",
      `--since=${Math.max(1, Math.floor(windowDays))}.days`,
      `--max-count=${GIT_ACTIVITY_MAX_COMMITS}`,
      "--no-merges",
      "--name-only",
      `--format=${MARK}%ct`,
    ]);
    return parseGitActivity(output);
  } catch {
    return [];
  }
}
