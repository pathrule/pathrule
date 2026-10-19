// SPDX-License-Identifier: Apache-2.0
// Read access to a workspace's local atom store, for a writer that must not name a backend.
//
// Approved knowledge atoms are local by design: a cloud workspace keeps them in the local store the
// review queue wrote them to. The hook-index writer reads them for a workspace whose own backend
// cannot hold them, and it reaches that store only through this port, which the composition root
// (CLI, MCP server, host) supplies. That keeps the writer free of the storage implementation, so a
// surface that loads the writer does not load SQLite until a store is actually opened.

import type { HookIndex } from "./hook-index.js";

/**
 * The part of a local store the hook-index writer reads. The caller closes it, and awaits the close
 * of a store reached through the host (closing may stop a host the opener ran).
 */
export interface LocalAtomStoreReader {
  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null>;
  close(): void | Promise<void>;
}

/** Opens a workspace's local atom store. Called only when the store's database already exists. */
export type OpenLocalAtomStore = (
  workspaceId: string,
  env: Record<string, string | undefined>,
) => LocalAtomStoreReader | Promise<LocalAtomStoreReader>;
