// SPDX-License-Identifier: Apache-2.0
//
// What a backend hands the knowledge map in one read. Types only: the map itself is
// computed in @pathrule/shared/knowledge-map, and parseKnowledgeMapInput (the boundary
// check for RPC payloads) lives there too, so this module adds no runtime code to core.

export type KnowledgeMapItemKind = "memory" | "rule" | "skill";

export interface KnowledgeMapItemInput {
  id: string;
  kind: KnowledgeMapItemKind;
  title: string;
  description: string | null;
  body: string;
  /** Workspace-relative node paths ("/packages/app"); a rule or skill may sit on several. */
  nodePaths: string[];
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

/** Where memory-to-memory similarity comes from: hosted vectors, locally computed vectors, or text. */
export type KnowledgeMapSemanticSource = "voyage" | "local" | "lexical";

export interface KnowledgeMapInput {
  workspaceId: string;
  items: KnowledgeMapItemInput[];
  /** [a, b, cosine]: top-k memory neighbours from the backend's vector store. Empty for lexical. */
  neighbours: Array<[string, string, number]>;
  semantic: KnowledgeMapSemanticSource;
  /** Distinct sessions that received each item in the window; null when the backend records none. */
  usage: Record<string, number> | null;
  usageWindowDays: number | null;
}

/** Knowledge-gap findings as Knowledge Maintenance holds them. */
export interface KnowledgeGapSummary {
  /** Directory scopes of open gaps, no leading slash. */
  openScopes: string[];
  /** Gaps resolved in the last 30 days: closed by recorded knowledge or dismissed. */
  closedLast30Days: number;
}
