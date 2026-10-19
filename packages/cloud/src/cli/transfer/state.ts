// SPDX-License-Identifier: Apache-2.0
// What a copy of Local knowledge to a Pathrule Cloud workspace did, item by item, kept on this
// machine: `<PATHRULE_HOME>/transfers/<local workspace>--<cloud workspace>.json` (0600, written
// atomically). A later `pathrule setup --cloud` reads it to offer the rest, to report what was cut,
// and to remember a "no" so it does not ask again.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "@pathrule/core/storage/atomic-write.js";
import {
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
  pathruleHome,
} from "@pathrule/core/storage/paths.js";

import type { TransferKind } from "./source.js";

export const TRANSFER_STATE_SCHEMA = 1;

/**
 * - `copied`: on Pathrule Cloud (written by this copy, or already there under its id).
 * - `failed`: the Cloud refused it (`code`, `message`); a later run tries again.
 * - `too_large`: over a size or title limit; never sent, never shortened.
 * - `not_attempted`: a run stopped before it (`code` says why); a later run tries again.
 */
export type TransferItemStatus = "copied" | "failed" | "too_large" | "not_attempted";

export interface TransferItemRecord {
  kind: TransferKind;
  local_id: string;
  title: string;
  status: TransferItemStatus;
  code?: string;
  message?: string;
  at: string;
}

export interface TransferState {
  schema: typeof TRANSFER_STATE_SCHEMA;
  local_workspace_id: string;
  cloud_workspace_id: string;
  started_at: string;
  updated_at: string;
  /** When the person said no; later runs do not ask again unless given --transfer. */
  declined_at: string | null;
  /** By the item's id on Pathrule Cloud. */
  items: Record<string, TransferItemRecord>;
}

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function transferStatePath(
  env: NodeJS.ProcessEnv,
  localWorkspaceId: string,
  cloudWorkspaceId: string,
): string {
  if (!ID.test(localWorkspaceId) || !ID.test(cloudWorkspaceId))
    throw new Error("not a Pathrule workspace id");
  return join(pathruleHome(env), "transfers", `${localWorkspaceId}--${cloudWorkspaceId}.json`);
}

export function emptyTransferState(
  localWorkspaceId: string,
  cloudWorkspaceId: string,
  now: string,
): TransferState {
  return {
    schema: TRANSFER_STATE_SCHEMA,
    local_workspace_id: localWorkspaceId,
    cloud_workspace_id: cloudWorkspaceId,
    started_at: now,
    updated_at: now,
    declined_at: null,
    items: {},
  };
}

/** The state of this pair; null when none was written or it does not read as one. */
export async function readTransferState(
  env: NodeJS.ProcessEnv,
  localWorkspaceId: string,
  cloudWorkspaceId: string,
): Promise<TransferState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(transferStatePath(env, localWorkspaceId, cloudWorkspaceId), "utf8"),
    );
  } catch {
    return null;
  }
  const state = raw as Partial<TransferState> | null;
  if (
    !state ||
    state.schema !== TRANSFER_STATE_SCHEMA ||
    state.local_workspace_id !== localWorkspaceId ||
    state.cloud_workspace_id !== cloudWorkspaceId ||
    !state.items ||
    typeof state.items !== "object"
  )
    return null;
  return {
    ...emptyTransferState(localWorkspaceId, cloudWorkspaceId, String(state.started_at ?? "")),
    updated_at: String(state.updated_at ?? ""),
    declined_at: typeof state.declined_at === "string" ? state.declined_at : null,
    items: state.items,
  };
}

export async function writeTransferState(
  env: NodeJS.ProcessEnv,
  state: TransferState,
): Promise<string> {
  const file = transferStatePath(env, state.local_workspace_id, state.cloud_workspace_id);
  await mkdir(join(pathruleHome(env), "transfers"), { recursive: true, mode: PATHRULE_DIR_MODE });
  await atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, { mode: PATHRULE_FILE_MODE });
  return file;
}
