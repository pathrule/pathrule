// SPDX-License-Identifier: Apache-2.0
// BindingManager holds the current FolderBinding and notifies subscribers on
// change. Deliberately vscode-free (plain listener set) so it unit-tests
// without the extension host; extension.ts adapts it to vscode events.

import {
  resolveFolderBinding,
  type BindingDeps,
  type FolderBinding,
  type FolderEdition,
} from "./types.js";

export type BindingListener = (binding: FolderBinding | null) => void;

export class BindingManager {
  private binding: FolderBinding | null = null;
  private listeners = new Set<BindingListener>();
  private resolveSeq = 0;

  constructor(
    private readonly folder: string | null,
    private readonly deps: BindingDeps,
  ) {}

  /** null until the first revalidate() completes (UI shows "resolving"). */
  current(): FolderBinding | null {
    return this.binding;
  }

  /** The open folder's edition, read now (setup compares the person's pick with it). */
  async folderEdition(): Promise<FolderEdition | null> {
    return this.folder ? this.deps.resolveMode(this.folder) : null;
  }

  onDidChange(listener: BindingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-runs resolution. Stale async results are dropped (sequence guard). */
  async revalidate(): Promise<FolderBinding | null> {
    if (!this.folder) {
      this.set(null);
      return null;
    }
    const seq = ++this.resolveSeq;
    let next: FolderBinding;
    try {
      next = await resolveFolderBinding(this.folder, this.deps);
    } catch {
      // Resolution failure (a corrupt store, an unreadable home) renders as unbound with nothing
      // known, which the person can retry. It never binds the other edition.
      next = {
        kind: "unbound",
        mode: null,
        reason: "failed",
        hasSession: false,
        localAvailable: false,
      };
    }
    if (seq !== this.resolveSeq) return this.binding;
    this.set(next);
    return next;
  }

  private set(next: FolderBinding | null): void {
    this.binding = next;
    for (const listener of this.listeners) listener(next);
  }
}
