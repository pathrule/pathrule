// SPDX-License-Identifier: Apache-2.0
import type { Memory, Rule, Skill } from "@pathrule/protocol/content-types.js";

export interface CompactMemory {
  id: string;
  title: string;
  content: string;
  node_path: string | null;
  source: "claude" | "manual";
  version_id: string;
  updated_at: string;
}

export interface CompactRule {
  id: string;
  name: string;
  content: string;
  node_path: string | null;
  scope_type: "folder" | "file_type" | "project";
  priority: "high" | "medium" | "low";
  version_id: string;
  updated_at: string;
}

export interface CompactSkill {
  id: string;
  name: string;
  content: string;
  node_path: string | null;
  source: "manual" | "template" | "github_ref";
  version_id: string;
  updated_at: string;
}

export function compactMemory(
  row: Memory & { nodeRelativePath?: string | null },
): CompactMemory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    node_path: row.nodeRelativePath ?? null,
    source: row.source,
    version_id: row.versionId,
    updated_at: row.updatedAt,
  };
}

export function compactRule(
  row: Rule & { nodeRelativePath?: string | null },
): CompactRule {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    node_path: row.nodeRelativePath ?? null,
    scope_type: row.scopeType,
    priority: row.priority,
    version_id: row.versionId,
    updated_at: row.updatedAt,
  };
}

export function compactSkill(
  row: Skill & { nodeRelativePath?: string | null },
): CompactSkill {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    node_path: row.nodeRelativePath ?? null,
    source: row.source,
    version_id: row.versionId,
    updated_at: row.updatedAt,
  };
}
