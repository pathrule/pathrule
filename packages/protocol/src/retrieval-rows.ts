// SPDX-License-Identifier: Apache-2.0
// Rows a retrieval query returns and a retrieval signal reads: pure shapes shared by the open side,
// the engine's signals and the cloud's queries.

export interface RelatedPathRow {
  path: string;
  weight: number;
}

/**
 * A relevant episode as returned by pathrule_relevant_work_episodes and
 * surfaced in the router response.
 */
export interface RelevantEpisode {
  id: string;
  title: string;
  paths: string[];   // server-trimmed to ≤ 2
  age_days: number;
  confidence: "medium" | "high";
}

export type ProactiveSignalKind = "co_change_miss";

/** One directive signal projected from a retrieval result, surfaced beside it in get_context. */
export interface ProactiveSignal {
  kind: ProactiveSignalKind;
  message: string;
  evidence_path: string;
  weight: number;
}
