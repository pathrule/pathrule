// SPDX-License-Identifier: Apache-2.0
/**
 * The one place in the host that opens a local store. A store is opened once, on first use, and
 * kept open; the host closes every store when it stops. Ids reach the host from clients, so an id
 * that could name a path outside the Pathrule home is refused before anything touches the disk.
 */
import { LocalBackend } from "@pathrule/core/backend/local/local-backend.js";

/** Workspace ids are UUIDs today; anything with a separator, a dot or a leading dash is refused. */
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type StoreOpener = (workspaceId: string, env: NodeJS.ProcessEnv) => LocalBackend;

const openCanonicalStore: StoreOpener = (workspaceId, env) =>
  LocalBackend.openForWorkspace(workspaceId, env);

export class InvalidWorkspaceIdError extends Error {
  constructor(workspaceId: string) {
    super(`"${workspaceId}" is not a workspace id`);
    this.name = "InvalidWorkspaceIdError";
  }
}

export class StoresClosedError extends Error {
  constructor() {
    super("the host has stopped; its stores are closed");
    this.name = "StoresClosedError";
  }
}

export class WorkspaceStores {
  private readonly stores = new Map<string, LocalBackend>();
  private closed = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly opener: StoreOpener = openCanonicalStore,
  ) {}

  /** The store of `workspaceId`, opened on first use. */
  get(workspaceId: string): LocalBackend {
    if (this.closed) throw new StoresClosedError();
    if (!WORKSPACE_ID.test(workspaceId)) throw new InvalidWorkspaceIdError(workspaceId);
    let store = this.stores.get(workspaceId);
    if (!store) {
      store = this.opener(workspaceId, this.env);
      this.stores.set(workspaceId, store);
    }
    return store;
  }

  /**
   * Marks the store of `workspaceId` as a mirror: a local copy of a workspace hosted elsewhere, which
   * local discovery skips, so a folder the copy covers still resolves to the hosted workspace.
   */
  markMirror(workspaceId: string): void {
    if (this.closed) throw new StoresClosedError();
    if (!WORKSPACE_ID.test(workspaceId)) throw new InvalidWorkspaceIdError(workspaceId);
    LocalBackend.markAsMirror(workspaceId, this.env);
  }

  /** The workspaces whose store is open. */
  openWorkspaceIds(): string[] {
    return [...this.stores.keys()];
  }

  /** Closes every store; later `get` calls throw. Returns the failures, if any. */
  closeAll(): Error[] {
    this.closed = true;
    const failures: Error[] = [];
    for (const [workspaceId, store] of this.stores) {
      try {
        store.close();
      } catch (err) {
        failures.push(
          new Error(
            `closing the store of ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }
    this.stores.clear();
    return failures;
  }
}
