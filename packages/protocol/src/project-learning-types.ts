// SPDX-License-Identifier: Apache-2.0
export interface ManifestFacts {
  ecosystem: "node" | "rust" | "python" | "go";
  name?: string;
  dependencies: Array<{ name: string; kind: "runtime" | "development" | "peer" | "optional" }>;
  taskNames: string[];
}

export interface ProjectSource {
  path: string;
  language: string;
  kind: "source" | "manifest";
  /** Git blob id for an unchanged index entry; SHA-256 for bytes read locally. */
  digest?: string;
  facts?: ManifestFacts;
  /** `oversized`: over the per-file read cap, so listed without a locally read digest.
   *  Unlike `unavailable` it does not make the inventory incomplete. */
  observation: "indexed" | "read" | "oversized" | "unavailable";
}

export interface ProjectMapSnapshot {
  version: 1;
  rootKey: string;
  observedAt: string;
  head: string | null;
  phase: "initial" | "incremental";
  inventory: "git" | "filesystem";
  consistency: "stable" | "changed_during_scan";
  files: ProjectSource[];
  coverage: {
    inventoryComplete: boolean;
    listedFiles: number;
    capturedFiles: number;
    unavailableFiles: number;
    /** Absent in snapshots written before oversized files were tracked. */
    oversizedFiles?: number;
    reusedManifests: number;
    readBytes: number;
  };
  changes: { added: number; changed: number; removed: number | null };
  /** Bounded observations retained across scans, never a claim of learned coverage. */
  reviewTargets?: SourceReviewTarget[];
  reviewTargetsTruncated?: boolean;
}

export interface SourceReviewTarget {
  path: string;
  reason: "initial" | "added" | "changed" | "removed";
  digest?: string;
}

export interface ProjectMapContext {
  status: "current" | "partial" | "unavailable";
  phase?: ProjectMapSnapshot["phase"];
  head?: string | null;
  observedAt?: string;
  coverage?: ProjectMapSnapshot["coverage"];
  changes?: ProjectMapSnapshot["changes"];
  persisted: boolean;
  modules: Array<{
    path: string;
    name?: string;
    ecosystem: string;
    evidence: { path: string; digest: string };
    dependencies: Array<{ name: string; kind: string; sameNameModule?: string }>;
    taskNames: string[];
    sourceExamples: string[];
  }>;
  sourceExamples: string[];
  omittedModules?: number;
  reviewTargets?: SourceReviewTarget[];
  reviewTargetsTruncated?: boolean;
  instruction: string;
}

export interface ProjectMapOptions {
  workspaceId: string;
  localRootPath: string;
  env?: NodeJS.ProcessEnv;
  scope?: string;
  maxFiles?: number;
  maxReadBytes?: number;
  timeoutMs?: number;
  /** Sources from claims verified against this checkout during the current request. */
  verifiedSources?: Array<{ path: string; digest: string }>;
}
