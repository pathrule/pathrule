// SPDX-License-Identifier: Apache-2.0
// The dedup contract types, split out of dedup.ts so the core backends can
// import them without dragging the database query wrapper into this shared
// export set. dedup.ts re-exports these.

export type DedupKind = "skill" | "memory" | "rule";

export interface DedupSimilarEntry {
  id: string;
  title: string;
  similarity: number;
}

export interface DedupCheckResult {
  duplicate: { id: string; title: string } | null;
  similar: DedupSimilarEntry[];
}

export interface DedupCheckArgs {
  workspaceId: string;
  kind: DedupKind;
  /** Required when kind === "memory"; ignored for skill/rule. */
  nodeId?: string | null;
  candidate: string;
  /** Pass the row's own id on updates so it's not flagged as colliding with itself. */
  excludeId?: string | null;
  /** word_similarity threshold, 0..1. Default 0.65. */
  threshold?: number;
  /** Cap on `similar` array length. Default 5. Pass 0 to skip the fuzzy scan. */
  maxSimilar?: number;
}
