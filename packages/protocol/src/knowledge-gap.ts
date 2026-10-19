// SPDX-License-Identifier: Apache-2.0
/**
 * A knowledge gap as delivery sees it: change in the repository that no knowledge anchors. Finding
 * gaps is an engine's (none ships today); carrying and rendering them is open.
 */

export interface KnowledgeGap {
  /** Session ledger key for in-flow delivery: "gap_" + stableHash("gap:" + scope). */
  ref: string;
  /** Directory, depth <= 4, no leading slash. */
  scope: string;
  kind: "uncovered" | "stale";
  files: number;
  commits: number;
  anchoredShare: number;
  commitsAfterKnowledge: number;
  newestKnowledgeAt: number | null;
  lastChangedAt: number;
  /** Up to 12 changed files, most-changed first; paths only, never content. */
  topPaths: string[];
  severity: "attention" | "risk";
}

/** The commit window gaps are measured over, in days; delivery names it in the rendered line. */
export const COVERAGE_WINDOW_DAYS = 60;

/** The shallowest directory depth a path anchors knowledge at (the knowledge map uses it too). */
export const ANCHOR_MIN_DEPTH = 3;
