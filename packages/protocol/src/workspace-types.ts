// SPDX-License-Identifier: Apache-2.0
// Shapes for workspace, Git and watcher flows.

export type GitProvider = "github" | "gitlab" | "bitbucket" | "other";

export interface GitMetadata {
  remoteUrl: string;
  provider: GitProvider;
  owner: string | null;
  repo: string | null;
}

export interface ScannedFolder {
  path: string;
  name: string; // basename
  hasGit: boolean;
  git: GitMetadata | null; // null when hasGit=false or parse fails
}

export interface ManagedGitignoreStatus {
  hasGit: boolean;
  gitignorePath: string | null;
  managedPaths: string[];
  trackedPaths: string[];
  hasManagedBlock: boolean;
}

export type WatcherEventType = "add" | "addDir" | "change" | "unlink" | "unlinkDir";

export interface WatcherEvent {
  workspaceId: string;
  type: WatcherEventType;
  relativePath: string;
}

/** Why main gave up on watching a workspace. Deliberately NOT a WatcherEventType:
 *  that union is switched on by work-state-tracker, use-watcher (unlink→orphan) and
 *  every onWorkspaceFileChange consumer, so a synthetic member would fire real
 *  file-change paths for a non-file event. */
export type WatcherRetiredReason = "emfile_exhausted";

/** Main → renderer: this workspace has no watcher any more and no further
 *  WatcherEvent will ever arrive for it. Without this the renderer cannot tell
 *  "the disk is quiet" from "nobody is listening". */
export interface WatcherRetiredNotice {
  workspaceId: string;
  reason: WatcherRetiredReason;
}

/** A single filesystem child returned by the lazy read-dir IPC. */
export interface FsEntry {
  /** Absolute path on disk (used internally; not shown to the user). */
  absPath: string;
  /** Path relative to the workspace root, leading-slash form: "/src/app". */
  relativePath: string;
  /** Last segment of the path. */
  name: string;
  isDir: boolean;
}

/** Lightweight metadata used to choose a bounded file-preview strategy. */
export interface WorkspacePreviewFileStat {
  size: number;
  modifiedAt: string;
}
