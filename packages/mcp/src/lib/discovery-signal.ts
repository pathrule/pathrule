// SPDX-License-Identifier: Apache-2.0
import type { DiscoverySignal, SubtreeMemoryIndexEntry } from "@pathrule/protocol/routing-types.js";

interface BuildDiscoverySignalInput {
  matchedNodePath: string;
  directMemoryCount: number;
  subtreeIndex?: SubtreeMemoryIndexEntry[];
  semanticCandidates?: Array<{ confidence?: string }>;
  subtreeBudget: number;
  truncated?: boolean;
  ancestorsWalked: boolean;
}

export function buildDiscoverySignal(
  input: BuildDiscoverySignalInput,
): DiscoverySignal | undefined {
  if (input.directMemoryCount > 0) return undefined;

  const subtreeIndex = input.subtreeIndex ?? [];
  const descendantsCount = subtreeIndex.length;
  const semanticCandidates = input.semanticCandidates ?? [];
  const semanticHighCount = semanticCandidates.filter(
    (candidate) => candidate.confidence === "high",
  ).length;
  const subtreeBudget = Math.max(input.subtreeBudget, 0);
  const subtreeTruncated = input.truncated === true;

  let recommendation: DiscoverySignal["recommendation"];
  if (descendantsCount > 0) {
    recommendation = "answer_from_subtree_titles";
  } else if (semanticHighCount > 0) {
    recommendation = "inspect_semantic_candidates";
  } else if (semanticCandidates.length > 0) {
    recommendation = "low_semantic_confidence";
  } else if (subtreeBudget === 0) {
    recommendation = "open_workspace_overview";
  } else if (subtreeTruncated) {
    recommendation = "widen_subtree_budget";
  } else {
    recommendation = "no_match_in_workspace";
  }

  return {
    no_direct_memories: true,
    descendants_have_memories: descendantsCount,
    candidate_memory_titles:
      descendantsCount > 0
        ? subtreeIndex.slice(0, 5).map((entry) => ({
            id: entry.id,
            title: entry.title,
            node_path: entry.node_path,
          }))
        : undefined,
    searched_scope: {
      matched_node_path: input.matchedNodePath || "/",
      subtree_budget: subtreeBudget,
      subtree_truncated: subtreeTruncated,
      ancestors_walked: input.ancestorsWalked,
    },
    recommendation,
    semantic_candidates_count:
      semanticCandidates.length > 0 ? semanticCandidates.length : undefined,
    semantic_high_confidence_count: semanticHighCount > 0 ? semanticHighCount : undefined,
    semantic_instruction:
      semanticCandidates.length > 0
        ? "Semantic candidates are evidence, not answers. Call pathrule_read_memory(id) before using one as an answer source."
        : undefined,
  };
}
