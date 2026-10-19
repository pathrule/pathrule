// SPDX-License-Identifier: Apache-2.0
// Knowledge kept as history, not as context.
//
// Knowledge that describes removed code is moved under an `_archive` node (`/_archive/studio`,
// `/_archive/reels`, ...) instead of being deleted, so its record survives. Such an item is no longer
// true of anything an agent can touch, so default delivery skips it: the hook index and its server
// ranking, the compiled instruction files, and get_context's overview and candidates. An explicit
// read still reaches it: an item by id, the archive node itself, a lookup by title.
//
// Workspace-relative node paths only (`/apps/web`); they are exact-compared everywhere else too.

/** The node-path segment that marks an archive. */
export const KNOWLEDGE_ARCHIVE_SEGMENT = "_archive";

/** True when a workspace-relative node path lies in an archive (any segment is `_archive`). */
export function isArchivedKnowledgePath(nodePath: string | null | undefined): boolean {
  if (typeof nodePath !== "string" || nodePath.length === 0) return false;
  return nodePath.split("/").includes(KNOWLEDGE_ARCHIVE_SEGMENT);
}
