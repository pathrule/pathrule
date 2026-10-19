// SPDX-License-Identifier: Apache-2.0
// The shapes of what an engine may read of a workspace through the host
// (`WorkspaceReadPort`, in core's engine contracts): its knowledge, its usage, Git and its files.
// Read-only: every change the engine wants goes back to a person as a proposal.

export type KnowledgeField = "title" | "content" | "createdAt" | "updatedAt";

/** Which active memories or rules to read. */
export interface KnowledgeQuery {
  /** The fields read besides the id; a field not asked for reads as "". */
  fields?: readonly KnowledgeField[];
  /** The node paths: `placed` keeps only items on a node, `any` keeps every item. Absent: not read. */
  nodes?: "placed" | "any";
  /** Only items created strictly before this ISO time. */
  createdBefore?: string;
  /** Only items last updated strictly before this ISO time. */
  updatedBefore?: string;
  /**
   * Every active item, ordered by id, or a thrown error. Without it a store may answer a bounded
   * set, and answers none when its read fails, as a cloud read does.
   */
  complete?: boolean;
}

export interface KnowledgeRow {
  id: string;
  /** A memory's title or a rule's name. */
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** Where the item is placed, in the store's order; a memory sits on one node. */
  nodePaths: string[];
}

/** The newest activity entries; a failed read answers none. */
export interface ActivityQuery {
  limit: number;
  /** Read each entry's time too; otherwise `createdAt` is "". */
  withCreatedAt?: boolean;
}

export interface ActivityRow {
  taskSummary: string | null;
  createdAt: string;
}

/** Two memories whose stored vectors are nearly the same. */
export interface DuplicateMemoryPair {
  memoryId: string;
  memoryTitle: string | null;
  otherMemoryId: string;
  otherMemoryTitle: string | null;
  similarity: number;
  sameNode: boolean;
}

/** A recorded learning claim as stored; the reader parses and verifies it. */
export interface LearningClaimRow {
  claim: unknown;
  createdAt: string;
}

/** How far Git impact has read a branch's history, as the store keeps it. */
export interface GitCheckpoint {
  branch: string;
  headSha: string;
  defaultBranch: string;
  legacyBaselineSha: string | null;
  legacyUnverifiedCount: number;
  pendingHeadSha: string | null;
  pendingBaseSha: string | null;
  pendingCursor: string | null;
}

export interface GitRepositorySnapshot {
  headSha: string;
  branch: string;
  defaultBranch: string;
}

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "rewritten"
  | "unknown";

export interface GitChangedPath {
  kind: GitChangeKind;
  path: string;
  oldPath: string | null;
  similarity: number | null;
}

/** The files that changed between two commits. */
export interface GitChangeSet {
  /** The base actually compared: the merge base when history was rewritten. */
  baseSha: string;
  changes: GitChangedPath[];
  historyRewritten: boolean;
  /** This clone is behind the checkpoint; nothing was compared. */
  behindCheckpoint: boolean;
}

export interface GitCommitActivity {
  /** Unix seconds. */
  committedAt: number;
  /** Workspace-relative, no leading slash. */
  paths: string[];
}

export type WorkspaceEntryKind = "file" | "directory" | "other";

export interface WorkspaceEntry {
  name: string;
  /** As the directory lists it: a symbolic link is `other`. */
  kind: WorkspaceEntryKind;
}

/** One side of a title pair sent for adjudication. */
export interface TitlePairCandidate {
  id: string;
  type: "memory" | "rule";
  title: string;
}

/** The hosted adjudication of one title pair, as it answers. */
export interface TitlePairVerdict {
  pair_index: number;
  verdict: "equivalent" | "supersede" | "contradict" | "independent";
  superseded_id?: string;
  confidence?: number;
  reason?: string;
}
