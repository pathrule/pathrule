// SPDX-License-Identifier: Apache-2.0
// get_context's default answer leaves archived knowledge out (`knowledge-archive.ts`): the subtree
// index and the semantic candidates here, the overview in core's getContextHandler. A request for a
// path inside an archive keeps it, and the explicit reads (read_memory, get_node, resolve) never pass
// through here.

import { isArchivedKnowledgePath } from "@pathrule/protocol/knowledge-archive.js";
import type {
  SemanticCandidatesPayload,
  SubtreeMemoryIndexResult,
} from "@pathrule/protocol/routing-types.js";

export function withoutArchivedSubtree(
  index: SubtreeMemoryIndexResult | undefined,
  requestedPath: string,
): SubtreeMemoryIndexResult | undefined {
  if (!index || isArchivedKnowledgePath(requestedPath)) return index;
  const entries = index.entries.filter((entry) => !isArchivedKnowledgePath(entry.node_path));
  if (entries.length === index.entries.length) return index;
  return { ...index, entries, total: index.total - (index.entries.length - entries.length) };
}

export function withoutArchivedCandidates(
  payload: SemanticCandidatesPayload | undefined,
  requestedPath: string,
): SemanticCandidatesPayload | undefined {
  if (!payload || isArchivedKnowledgePath(requestedPath)) return payload;
  const candidates = payload.candidates.filter((c) => !isArchivedKnowledgePath(c.node_path));
  return candidates.length === payload.candidates.length ? payload : { ...payload, candidates };
}
