// SPDX-License-Identifier: Apache-2.0
//
// The knowledge map a backend input turns into. Plain data: every reader (the
// CLI, the local MCP server, Remote MCP) computes the same map from the same input, so it is
// never persisted and never shared between surfaces.

import type { KnowledgeMapItemKind, KnowledgeMapSemanticSource } from "../backend/knowledge-map-input.js";
import type { LinkStage } from "./links.js";

/** Bumped whenever the same input could produce a different map. Part of every cache key. */
export const KNOWLEDGE_MAP_ALGORITHM = "m202.v1";

export type MapEdgeKind = "link" | "semantic";

export interface MapEdge {
  /** a < b */
  a: string;
  b: string;
  weight: number;
  kinds: MapEdgeKind[];
  /** Vector-scale similarity when the edge has a semantic part. */
  similarity?: number;
}

export interface MapItem {
  id: string;
  kind: KnowledgeMapItemKind;
  title: string;
  nodePaths: string[];
  oneLiner: string;
  /** Body and description characters / 4. */
  tokens: number;
  updatedAt: string;
  /** Explicit path references in the body, plus their node-relative readings, without a leading slash. */
  anchors: string[];
  regionId: string | null;
  subRegionId: string | null;
  /** In a region by its path, not by a content edge (plan D9). */
  loose: boolean;
  /** Sessions that received the item in the usage window; null when usage is unknown. */
  sessions: number | null;
}

export interface KnowledgeSubRegion {
  id: string;
  anchorId: string;
  memberIds: string[];
}

export interface KnowledgeRegion {
  id: string;
  anchorId: string;
  memberIds: string[];
  terms: string[];
  homePath: string;
  pathFit: number;
  cohesion: number;
  tokens: number;
  neighbours: Array<{ regionId: string; weight: number }>;
  /** Audit pages. A region under the split threshold is one page with no sub-regions. */
  subRegions: KnowledgeSubRegion[];
}

export type MapFinding =
  | { kind: "consolidate"; itemIds: string[]; maxSimilarity: number }
  | { kind: "companion_unlinked"; itemIds: [string, string]; similarity: number }
  | { kind: "dangling_link"; itemId: string; target: string }
  | { kind: "scope_down_candidate"; itemId: string; regionId: string; homePath: string; share: number }
  | { kind: "junction"; itemId: string; regionIds: string[]; participation: number }
  | { kind: "unused"; itemId: string; windowDays: number };

export interface KnowledgeMap {
  algorithm: typeof KNOWLEDGE_MAP_ALGORITHM;
  workspaceId: string;
  fingerprint: string;
  generatedAt: string;
  semantic: KnowledgeMapSemanticSource;
  items: Record<string, MapItem>;
  edges: MapEdge[];
  regions: KnowledgeRegion[];
  /** Root items with no topical edge: how the workspace works, not what it is about. */
  conventions: string[];
  findings: MapFinding[];
  links: { resolved: number; byStage: Record<LinkStage, number>; dangling: number };
}
