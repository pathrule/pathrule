// SPDX-License-Identifier: Apache-2.0
// FolderBinding: the extension's central state machine. The open folder's edition is the one answer
// every Pathrule surface uses (core's resolveFolderMode, read through ./folder-mode.ts): a Local
// folder binds to its Local workspace, a Cloud folder to its Cloud attachment. When that workspace
// cannot be shown here the folder is unbound with a reason the person can act on, and it never
// falls back to the other edition: a Cloud folder is never served from a Local store.

import type { KnowledgeBackend } from "@pathrule/core";
import type { WorkspaceMatch } from "@pathrule/core/backend/inputs.js";
import type { FolderModeResolution } from "@pathrule/core/workspace/folder-mode.js";

export type BindingKind = "cloud" | "local";

export interface BoundFolder {
  kind: BindingKind;
  backend: KnowledgeBackend;
  workspaceId: string;
  /** Workspace name when known (cloud create/list flows populate it). */
  workspaceName: string | null;
  /** Absolute path of the workspace's local root. */
  localRootPath: string;
  /** Leading-slash path of the open folder inside the workspace ("" = root). */
  relativePath: string;
  /**
   * Cloud only: subscribe to remote content changes (team edits). Returns an
   * unsubscribe. Local mode omits it (single principal, nothing remote).
   */
  onRemoteChange?: (listener: () => void) => () => void;
}

/**
 * Why nothing is shown for the folder, and so what the person can do:
 * - `not-set-up`: no workspace of the folder's edition covers it (Set up).
 * - `signed-out`: a Cloud folder, attached, and nobody is signed in here (Sign in).
 * - `cloud-unreachable`: a Cloud folder, attached and signed in, whose workspace did not open;
 *   `cloudFailure` says why: offline, no access for this account, or a Cloud failure (Try again).
 *   A session the Cloud no longer accepts is `signed-out`.
 * - `cloud-unavailable`: a Cloud folder in a build that names no Pathrule Cloud.
 * - `local-unavailable`: a Local folder where the Local store cannot run in this editor.
 * - `conflict`: a Local and a Cloud workspace on the folder and no choice (choose one).
 * - `failed`: the folder's edition could not be read (Try again).
 */
export type UnboundReason =
  | "not-set-up"
  | "signed-out"
  | "cloud-unreachable"
  | "cloud-unavailable"
  | "local-unavailable"
  | "conflict"
  | "failed";

export interface UnboundFolder {
  kind: "unbound";
  /** The folder's edition; null in a conflict, or when it could not be read. */
  mode: BindingKind | null;
  reason: UnboundReason;
  hasSession: boolean;
  /** Local mode availability: false when better-sqlite3 can't load in this host. */
  localAvailable: boolean;
  /**
   * A valid session held by another surface (Desktop/CLI) can be adopted into
   * this one with a single explicit click, no device-code login needed. Drives
   * the "Connect as <account>" status instead of "Set up".
   */
  canAdopt?: boolean;
  /** Account/email of the adoptable session, for the connect label. */
  adoptAccount?: string | null;
  /** cloud-unreachable only: why the workspace did not open, when the extension could tell. */
  cloudFailure?: "offline" | "access-denied" | "cloud-error";
  /** The Cloud workspace the folder is attached to, when it is one (signed out, unreachable). */
  cloudWorkspace?: { id: string; name: string };
  /** Conflict only: the folder in conflict and the sentence every Pathrule surface shows for it. */
  conflict?: { root: string; message: string };
}

export type FolderBinding = BoundFolder | UnboundFolder;

/** The folder's edition, and the sentence for a conflict (core's folderConflictMessage). */
export interface FolderEdition extends FolderModeResolution {
  conflictMessage: string | null;
}

/**
 * Injectable seams so the resolution is a pure, unit-testable function. Real wiring lives in
 * activate.ts (./folder-mode.ts, ./local.ts, ../cloud.ts); tests pass fakes.
 */
export interface BindingDeps {
  /** The folder's edition, read from files only: no network, no store opened for writing. */
  resolveMode(folder: string): Promise<FolderEdition>;
  /** The Cloud workspace the folder is attached to, opened for the signed-in person, or null. */
  openCloud(folder: string): Promise<BoundFolder | null>;
  /** Why openCloud gave null (a single request); absent in a build without that seam. */
  cloudFailure?(folder: string): Promise<"signed-out" | "not-attached" | "access-denied" | "offline" | "cloud-error">;
  /** The Local workspace the resolution named, opened through the home's host, or null. */
  openLocal(match: WorkspaceMatch): Promise<BoundFolder | null>;
  /** Whether this build can serve Pathrule Cloud (it names one). */
  cloudAvailable(): Promise<boolean>;
  /** True when a Pathrule Cloud session exists on this machine. */
  hasSession(): Promise<boolean>;
  /** Whether local mode can run in this host at all. */
  localAvailable(): Promise<boolean>;
  /** Account/email of a session adoptable into this surface, or null. Drives one-click connect. */
  adoptableAccount(): Promise<string | null>;
}

/** Why a folder whose workspace was not opened is unbound. Pure. */
export function unboundReason(
  edition: Pick<FolderModeResolution, "mode" | "local" | "cloud">,
  state: { hasSession: boolean; localAvailable: boolean; cloudAvailable: boolean },
): UnboundReason {
  if (edition.mode === null) return "conflict";
  if (edition.mode === "local") {
    return edition.local || !state.localAvailable ? "local-unavailable" : "not-set-up";
  }
  if (!state.cloudAvailable) return "cloud-unavailable";
  if (!edition.cloud) return "not-set-up";
  return state.hasSession ? "cloud-unreachable" : "signed-out";
}

export async function resolveFolderBinding(
  folder: string,
  deps: BindingDeps,
): Promise<FolderBinding> {
  const edition = await deps.resolveMode(folder);
  if (edition.mode === "local" && edition.local) {
    const local = await deps.openLocal(edition.local);
    if (local) return local;
  }
  const [hasSession, localAvailable, cloudAvailable, adoptAccount] = await Promise.all([
    deps.hasSession(),
    deps.localAvailable(),
    deps.cloudAvailable(),
    deps.adoptableAccount(),
  ]);
  let failure: Awaited<ReturnType<NonNullable<BindingDeps["cloudFailure"]>>> | null = null;
  if (edition.mode === "cloud" && edition.cloud && cloudAvailable && hasSession) {
    const cloud = await deps.openCloud(folder);
    // Only the workspace this folder is attached to: never another one the account resolves.
    if (cloud && cloud.workspaceId === edition.cloud.workspaceId) return cloud;
    // Why it did not open. Whatever the answer, the folder stays a Cloud folder: no Local fallback.
    failure = deps.cloudFailure ? await deps.cloudFailure(folder).catch(() => null) : null;
  }
  let reason = unboundReason(edition, { hasSession, localAvailable, cloudAvailable });
  if (reason === "cloud-unreachable" && failure === "signed-out") reason = "signed-out";
  const cloudFailure =
    reason === "cloud-unreachable" &&
    (failure === "offline" || failure === "access-denied" || failure === "cloud-error")
      ? failure
      : undefined;
  return {
    kind: "unbound",
    mode: edition.mode,
    reason,
    ...(cloudFailure ? { cloudFailure } : {}),
    hasSession,
    localAvailable,
    canAdopt: adoptAccount !== null,
    adoptAccount,
    ...(edition.cloud
      ? { cloudWorkspace: { id: edition.cloud.workspaceId, name: edition.cloud.name } }
      : {}),
    ...(edition.conflict
      ? { conflict: { root: edition.conflict.root, message: edition.conflictMessage ?? "" } }
      : {}),
  };
}
