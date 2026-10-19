// SPDX-License-Identifier: Apache-2.0
// The native Cloud's managed semantic search of one workspace (`/v1/workspaces/:ws/semantic`).
import { cloudHttp, type CloudTransport } from "./http.js";

export type CloudEmbeddingSpace = "cf-qwen3-embedding-0.6b-1024-v1" | "cf-bge-m3-1024-v1";

export interface CloudSemanticItem {
  id: string;
  kind: "memory" | "rule" | "skill";
  title: string;
  body: string;
  revision: number;
  score: number;
  semantic_rank: number;
  rrf_score: number;
}

// Managed search DTO, not KnowledgeBackend.semanticCandidates: that contract still
// needs memory-only shaping, lexical exclusions, confidence and canonical node paths.
export function createCloudSemanticClient(
  transport: CloudTransport,
  workspaceId: string,
  embeddingSpace?: CloudEmbeddingSpace,
) {
  const request = cloudHttp(transport);
  return {
    search: async (input: {
      intent: string;
      path?: string;
      scopeMode?: "subtree" | "exact" | "inherited" | "context";
    }): Promise<CloudSemanticItem[]> => {
      const response = await request<{ items: CloudSemanticItem[] }>(
        "/v1/workspaces/" + encodeURIComponent(workspaceId) + "/semantic",
        { ...input, embeddingSpace },
      );
      return response.items;
    },
  };
}
