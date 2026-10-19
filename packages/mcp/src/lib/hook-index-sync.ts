// SPDX-License-Identifier: Apache-2.0
// Which workspaces' hook index this process has already written.
//
// A local store is cheap to read, so local get_context rewrites the index on every call. An account's
// store is a network read, so get_context writes it once per process. A knowledge write in between
// changes what the index should hold (a deleted memory still delivered from the warehouse, a moved one
// still under its old path), so a successful write forgets the workspace here and the next get_context
// rewrites the index with everything it carries.

const synced = new Set<string>();

export const hookIndexSynced = (workspaceId: string): boolean => synced.has(workspaceId);

export function markHookIndexSynced(workspaceId: string): void {
  synced.add(workspaceId);
}

export function forgetHookIndexSync(workspaceId: string): void {
  synced.delete(workspaceId);
}
