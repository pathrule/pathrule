// SPDX-License-Identifier: Apache-2.0
/**
 * What a folder's change of edition leaves on this machine, and how each part is kept apart.
 *
 * - **A Local store set aside** (`.set-aside.json`): a Local workspace whose content may have come
 *   from Pathrule Cloud. Before folders had one edition each, a folder with a Local workspace and a
 *   Cloud attachment could be served from both, so what that store holds has no certain origin.
 *   Discovery never offers it again; nothing deletes it.
 * - **A Local store left dormant** (`.dormant.json`): the Local workspace of a folder this release
 *   switched to Pathrule Cloud. Nothing serves or writes it while the folder is a Cloud folder, so it
 *   holds only the person's own Local knowledge and serves the folder again if it switches back.
 * - **The Cloud machine cache**: what this machine keeps for a Cloud workspace, under
 *   `cache/<workspace id>/` (its hook index and session caches) and a store named by its id. It is a
 *   copy of that workspace's data, so it goes when its folder stops being a Cloud folder.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PATHRULE_FILE_MODE, pathruleHome } from "../storage/paths.js";

export const SET_ASIDE_MARKER = ".set-aside.json";
export const DORMANT_MARKER = ".dormant.json";

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

function storeDir(env: NodeJS.ProcessEnv, id: string): string {
  if (!ID.test(id)) throw new Error(`not a Pathrule workspace id: ${id}`);
  return join(pathruleHome(env), id);
}

/** Whether a Local store was set aside (its origin is uncertain): it never serves a folder again. */
export function isSetAside(env: NodeJS.ProcessEnv, id: string): boolean {
  return ID.test(id) && existsSync(join(pathruleHome(env), id, SET_ASIDE_MARKER));
}

/** Sets a Local store aside: kept on disk, never discovered, never written. */
export function setAsideLocalStore(
  env: NodeJS.ProcessEnv,
  id: string,
  reason: string,
  now: Date = new Date(),
): string {
  const dir = storeDir(env, id);
  writeFileSync(join(dir, SET_ASIDE_MARKER), `${JSON.stringify({ reason, at: now.toISOString() })}\n`, {
    mode: PATHRULE_FILE_MODE,
  });
  return dir;
}

export interface DormantMark {
  since: string;
  cloud_workspace_id: string | null;
}

/** Marks the Local store of a folder that switched to Pathrule Cloud. */
export function markLocalStoreDormant(
  env: NodeJS.ProcessEnv,
  id: string,
  cloudWorkspaceId: string | null,
  now: Date = new Date(),
): void {
  const mark: DormantMark = { since: now.toISOString(), cloud_workspace_id: cloudWorkspaceId };
  writeFileSync(join(storeDir(env, id), DORMANT_MARKER), `${JSON.stringify(mark)}\n`, {
    mode: PATHRULE_FILE_MODE,
  });
}

export function readDormantMark(env: NodeJS.ProcessEnv, id: string): DormantMark | null {
  try {
    const raw = JSON.parse(readFileSync(join(storeDir(env, id), DORMANT_MARKER), "utf8")) as Partial<DormantMark>;
    return typeof raw.since === "string"
      ? { since: raw.since, cloud_workspace_id: typeof raw.cloud_workspace_id === "string" ? raw.cloud_workspace_id : null }
      : null;
  } catch {
    return null;
  }
}

export function clearDormantMark(env: NodeJS.ProcessEnv, id: string): void {
  rmSync(join(storeDir(env, id), DORMANT_MARKER), { force: true });
}

/** Delivery receipts a Cloud workspace has not reported yet: counts by item id, no content. Kept. */
const KEPT_IN_CLOUD_CACHE = new Set(["deliveries", "deliveries-reported.json"]);

/**
 * Removes this machine's copy of a Cloud workspace's data: everything under `cache/<id>/` except
 * the delivery receipts still to be reported, and the store named by its id. Refuses a Local
 * workspace (`isLocalWorkspace`), whose store is the person's own knowledge.
 */
export function removeCloudMachineCache(
  env: NodeJS.ProcessEnv,
  cloudWorkspaceId: string,
  isLocalWorkspace: (id: string) => boolean,
): string[] {
  if (isLocalWorkspace(cloudWorkspaceId)) {
    throw new Error(`${cloudWorkspaceId} is a Local workspace, not a Pathrule Cloud workspace's cache`);
  }
  const removed: string[] = [];
  const cache = join(pathruleHome(env), "cache", storeId(cloudWorkspaceId));
  let entries: string[] = [];
  try {
    entries = readdirSync(cache);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (KEPT_IN_CLOUD_CACHE.has(entry)) continue;
    rmSync(join(cache, entry), { recursive: true, force: true });
    removed.push(join(cache, entry));
  }
  const store = storeDir(env, cloudWorkspaceId);
  if (existsSync(store)) {
    rmSync(store, { recursive: true, force: true });
    removed.push(store);
  }
  return removed;
}

function storeId(id: string): string {
  if (!ID.test(id)) throw new Error(`not a Pathrule workspace id: ${id}`);
  return id;
}
