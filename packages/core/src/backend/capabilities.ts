// SPDX-License-Identifier: Apache-2.0
/**
 * What a given KnowledgeBackend can actually do. The core MCP surface reads this
 * to silently omit response sections a backend cannot fill.
 *
 * - LocalBackend (self-hosted): aiMerge/aiGenerate/staleness/realtime = false;
 *   semantic / routerLLM reflect whether a bring-your-own key is present.
 * - Pathrule Cloud's project backend: semantic where its embeddings are configured; the rest false.
 */
export interface BackendCapabilities {
  /** Three-way AI merge of conflicting edits (hosted-only). */
  aiMerge: boolean;
  /** AI authoring/generation of memories/rules/skills (hosted-only). */
  aiGenerate: boolean;
  /** AI staleness detection that auto-populates the refresh queue (hosted-only). */
  staleness: boolean;
  /** Cross-client realtime sync / live activity (hosted-only). */
  realtime: boolean;
  /** Semantic (embedding) retrieval — true when a vector store + embedding key exist. */
  semantic: boolean;
  /** LLM-backed intent router — true when a router LLM key is present. */
  routerLLM: boolean;
}
