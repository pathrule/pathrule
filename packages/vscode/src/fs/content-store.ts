// SPDX-License-Identifier: Apache-2.0
// Backend-facing content IO for the pathrule:// filesystem — vscode-free so
// the conflict logic is unit-testable. The provider adapts this to
// FileSystemProvider and owns all UI.
//
// Concurrency model (Decision, autonomous): UpdateMemoryInput carries no
// expectedVersionId at the backend seam, so the store does read-compare-write:
// versionId is cached at read time and re-checked immediately before save.
// The small race window matches the MCP handler pattern; a conflict NEVER
// silently overwrites — the provider surfaces Reload / Copy My Version.

import type { KnowledgeBackend } from "@pathrule/core";

import type { ContentRef } from "./uri.js";

export interface ContentDocument {
  body: string;
  label: string;
  versionId: string;
  /** github_ref skills resolve remotely — read-only in the editor. */
  readonly: boolean;
  mtimeMs: number;
}

export type SaveResult =
  | { status: "saved"; versionId: string }
  | { status: "conflict" }
  | { status: "readonly" }
  | { status: "missing" };

interface CacheEntry {
  versionId: string;
  mtimeMs: number;
}

export class ContentStore {
  private readonly cache = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(private readonly backendFor: (workspaceId: string) => KnowledgeBackend | null) {}

  async read(ref: ContentRef): Promise<ContentDocument | null> {
    const backend = this.backendFor(ref.workspaceId);
    if (!backend) return null;
    const record = await readRecord(backend, ref);
    if (!record) {
      this.cache.delete(key(ref));
      return null;
    }
    // mtime advances ONLY when the version changed — otherwise background
    // re-reads would make VSCode believe the doc changed on disk and raise
    // spurious overwrite prompts (code-review fix #6).
    const cached = this.cache.get(key(ref));
    const mtimeMs = cached && cached.versionId === record.versionId ? cached.mtimeMs : ++this.clock;
    this.cache.set(key(ref), { versionId: record.versionId, mtimeMs });
    return { ...record, mtimeMs };
  }

  /** Explicit conflict resolution: accept the server version as baseline, then
   *  re-apply the user's buffer (chosen overwrite is allowed; SILENT never). */
  async overwrite(ref: ContentRef, body: string): Promise<SaveResult> {
    this.invalidate(ref);
    await this.read(ref);
    return this.save(ref, body);
  }

  cached(ref: ContentRef): CacheEntry | undefined {
    return this.cache.get(key(ref));
  }

  async save(ref: ContentRef, body: string): Promise<SaveResult> {
    const backend = this.backendFor(ref.workspaceId);
    if (!backend) return { status: "missing" };
    const current = await readRecord(backend, ref);
    if (!current) return { status: "missing" };
    if (current.readonly) return { status: "readonly" };
    const known = this.cache.get(key(ref));
    if (known && known.versionId !== current.versionId) return { status: "conflict" };

    const updated = await updateRecord(backend, ref, body);
    this.cache.set(key(ref), { versionId: updated.versionId, mtimeMs: ++this.clock });
    return { status: "saved", versionId: updated.versionId };
  }

  /** Drop the cached version so the next read accepts the server state (Reload). */
  invalidate(ref: ContentRef): void {
    this.cache.delete(key(ref));
  }
}

function key(ref: ContentRef): string {
  return `${ref.workspaceId}/${ref.kind}/${ref.id}`;
}

async function readRecord(
  backend: KnowledgeBackend,
  ref: ContentRef,
): Promise<Omit<ContentDocument, "mtimeMs"> | null> {
  switch (ref.kind) {
    case "memory": {
      const m = await backend.readMemory(ref.id);
      return m
        ? { body: m.content, label: m.title, versionId: m.versionId, readonly: false }
        : null;
    }
    case "rule": {
      const r = await backend.readRule(ref.id);
      return r ? { body: r.content, label: r.name, versionId: r.versionId, readonly: false } : null;
    }
    case "skill": {
      const s = await backend.readSkill(ref.id);
      return s
        ? {
            body: s.content,
            label: s.name,
            versionId: s.versionId,
            readonly: s.source === "github_ref",
          }
        : null;
    }
  }
}

async function updateRecord(
  backend: KnowledgeBackend,
  ref: ContentRef,
  body: string,
): Promise<{ versionId: string }> {
  switch (ref.kind) {
    case "memory":
      return backend.updateMemory({ id: ref.id, content: body });
    case "rule":
      return backend.updateRule({ id: ref.id, content: body });
    case "skill":
      return backend.updateSkill({ id: ref.id, content: body });
  }
}
