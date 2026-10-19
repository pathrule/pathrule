// SPDX-License-Identifier: Apache-2.0
// Shared shapes for the tree editor and the MCP tree tools.

export type NodeType = "folder" | "file" | "context";
export type NodeStatus = "active" | "orphan" | "archived";

// Workspace resolution from a cwd. Canonical shapes live here so
// mcp-server's workspace-matcher, the KnowledgeBackend.resolveWorkspaceFromCwd
// seam (hosted: injected closure; local: local store), and closestNode all share
// one contract.
export interface WorkspaceMatch {
  workspaceId: string;
  localRootPath: string;
  /** Leading-slash form inside the workspace, e.g. "/src/components". "" when cwd === root. */
  relativePath: string;
}

export interface ClosestNode {
  id: string;
  relativePath: string;
}

/**
 * Serialized row from the `nodes` table, camelCased for the renderer.
 * DB column mapping lives in `packages/app/src/lib/nodes.ts`.
 */
export interface TreeNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  type: NodeType;
  relativePath: string;
  orderIndex: number;
  status: NodeStatus;
  orphanedAt: string | null;
  originalPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for a new node that hasn't been persisted yet. The optimistic
 * create path generates `tempId` client-side via crypto.randomUUID() and
 * uses it as the row's id immediately, so the UI doesn't flicker when
 * the store echoes the real row back.
 */
export interface NodeDraft {
  tempId: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  type: NodeType;
}
