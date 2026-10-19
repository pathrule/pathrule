// SPDX-License-Identifier: Apache-2.0
// FileSystemProvider adapter over ContentStore. Memories/rules/skills open as
// ordinary markdown tabs; Cmd+S persists through the backend. Conflicts are
// loud (design skill rule 7).

import * as vscode from "vscode";

import type { BindingManager } from "../binding/manager.js";
import { strings } from "../ui/strings.js";
import { ContentStore } from "./content-store.js";
import { parseContentUri, type ContentRef } from "./uri.js";

export class PathruleFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  readonly store: ContentStore;
  /** Fired after a successful save so the tree/feed can refresh. */
  readonly onDidSave = new vscode.EventEmitter<ContentRef>();

  constructor(manager: BindingManager) {
    this.store = new ContentStore((workspaceId) => {
      const binding = manager.current();
      return binding !== null && binding.kind !== "unbound" && binding.workspaceId === workspaceId
        ? binding.backend
        : null;
    });
  }

  private ref(uri: vscode.Uri): ContentRef {
    const ref = parseContentUri(uri.authority, uri.path);
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri);
    return ref;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const ref = this.ref(uri);
    const cached = this.store.cached(ref);
    if (cached) {
      return { type: vscode.FileType.File, ctime: 0, mtime: cached.mtimeMs, size: 0 };
    }
    const doc = await this.store.read(ref);
    if (!doc) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: doc.mtimeMs, size: doc.body.length };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const doc = await this.store.read(this.ref(uri));
    if (!doc) throw vscode.FileSystemError.FileNotFound(uri);
    return new TextEncoder().encode(doc.body);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ref = this.ref(uri);
    const result = await this.store.save(ref, new TextDecoder().decode(content));
    switch (result.status) {
      case "saved":
        this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        this.onDidSave.fire(ref);
        return;
      case "readonly":
        void vscode.window.showWarningMessage(strings.editor.readonlySkill);
        throw vscode.FileSystemError.NoPermissions(uri);
      case "missing":
        throw vscode.FileSystemError.FileNotFound(uri);
      case "conflict": {
        void this.offerConflictActions(uri, content);
        throw vscode.FileSystemError.Unavailable(strings.editor.conflictShort);
      }
    }
  }

  private async offerConflictActions(uri: vscode.Uri, dirty: Uint8Array): Promise<void> {
    // Esc keeps the buffer untouched; the next save re-offers this dialog.
    // "Keep Mine" is the explicit way out (code-review fix #3) — a CHOSEN
    // overwrite, never a silent one.
    const choice = await vscode.window.showErrorMessage(
      strings.editor.conflictBody,
      strings.editor.conflictReload,
      strings.editor.conflictCopy,
      strings.editor.conflictKeepMine,
    );
    if (choice === strings.editor.conflictKeepMine) {
      const result = await this.store.overwrite(this.ref(uri), new TextDecoder().decode(dirty));
      if (result.status === "saved") {
        this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        this.onDidSave.fire(this.ref(uri));
        await vscode.commands.executeCommand("workbench.action.files.revert", uri);
      }
      return;
    }
    if (choice === strings.editor.conflictCopy) {
      await vscode.env.clipboard.writeText(new TextDecoder().decode(dirty));
    }
    if (choice === strings.editor.conflictReload || choice === strings.editor.conflictCopy) {
      this.store.invalidate(this.ref(uri));
      this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    // Deletion goes through the tree context menu (confirm + undo), not the FS.
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
