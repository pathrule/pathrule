// SPDX-License-Identifier: Apache-2.0
// Import a project's existing instruction files into the local store.
//
// CLAUDE.md, AGENTS.md, the `@import` chain, Cursor, Copilot and Windsurf rules
// and decision records become memories word for word, on the node each file
// describes. The Cloud setup imports the same files through the same
// drafts (`knowledge-import/`); this is the write for a local workspace, so a
// Core user starts with what the project already wrote down.
//
// Nothing Pathrule wrote enters the local store this way, Pathrule Cloud's
// output included: discovery declines those files, and files whose origin it
// cannot tell, and this reports them in `skipped`.

import type { LocalBackend } from "@pathrule/core";
import { inventoryKnowledgeSources } from "@pathrule/core/knowledge-import/discovery.js";
import {
  draftsBySource,
  missingDrafts,
  splitByPresence,
  type InstructionImportMode,
  type MemoryDraft,
} from "@pathrule/core/knowledge-import/drafts.js";
import type { PathruleOriginReason } from "@pathrule/core/knowledge-import/pathrule-origin.js";

type LocalInstructionStore = Pick<
  LocalBackend,
  "listMemories" | "listRules" | "listSkills" | "ensureNodeForPath" | "writeMemory"
>;

export interface LocalInstructionImport {
  /** Sections this run wrote. */
  imported: number;
  /** Sections this run tried to write and could not. */
  failed: number;
  /** Instruction files the store holds word for word. */
  inPathrule: string[];
  /** Instruction files the store does not hold yet. */
  notImported: string[];
  /**
   * Files left out because Pathrule wrote them or their origin is uncertain.
   * Present only when there is one, so a folder with none reads as before.
   */
  skipped?: SkippedInstructionFile[];
}

export interface SkippedInstructionFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  reason: PathruleOriginReason;
}

/**
 * Import the instruction files under `workspaceRoot`. Returns null when the
 * folder has none and skipped none. Modes are described on `InstructionImportMode`.
 */
export async function importLocalInstructions(args: {
  backend: LocalInstructionStore;
  workspaceId: string;
  workspaceRoot: string;
  mode: InstructionImportMode;
}): Promise<LocalInstructionImport | null> {
  const inventory = await inventoryKnowledgeSources(args.workspaceRoot).catch(() => ({
    sources: [],
    skipped: [],
  }));
  const bySource = draftsBySource(inventory.sources);
  // Documents are never imported here, so leaving one out is not news.
  const skipped: SkippedInstructionFile[] = inventory.skipped
    .filter((file) => file.kind !== "document")
    .map(({ path, reason }) => ({ path, reason }));
  const withSkipped = skipped.length > 0 ? { skipped } : {};
  if (bySource.length === 0) {
    return skipped.length > 0
      ? { imported: 0, failed: 0, inPathrule: [], notImported: [], skipped }
      : null;
  }

  const present = await memoryTitles(args.backend, args.workspaceId);
  let written: string[] = [];
  let failed = 0;
  if (args.mode === "missing" || (await isEmpty(args.backend, args.workspaceId))) {
    ({ written, failed } = await writeDrafts(
      args.backend,
      args.workspaceId,
      missingDrafts(bySource, present),
    ));
    for (const title of written) present.add(title);
  }
  return {
    imported: written.length,
    failed,
    ...splitByPresence(bySource, present),
    ...withSkipped,
  };
}

/** Every memory title in the workspace, archived ones included so a removed section stays removed. */
async function memoryTitles(
  store: LocalInstructionStore,
  workspaceId: string,
): Promise<Set<string>> {
  const [active, archived] = await Promise.all([
    store.listMemories({ workspaceId, status: "active" }),
    store.listMemories({ workspaceId, status: "archived" }),
  ]);
  return new Set([...active, ...archived].map((memory) => memory.title));
}

async function isEmpty(store: LocalInstructionStore, workspaceId: string): Promise<boolean> {
  const [memories, rules, skills] = await Promise.all([
    store.listMemories({ workspaceId }),
    store.listRules({ workspaceId }),
    store.listSkills({ workspaceId }),
  ]);
  return memories.length + rules.length + skills.length === 0;
}

/**
 * Write drafts as memories, each distinct node resolved once. Source `manual`,
 * as every setup writes them, because the words are the project's own. One
 * failed write does not stop the rest; it is counted.
 */
async function writeDrafts(
  store: LocalInstructionStore,
  workspaceId: string,
  drafts: readonly MemoryDraft[],
): Promise<{ written: string[]; failed: number }> {
  const nodeIdByPath = new Map<string, string>();
  for (const nodePath of new Set(drafts.map((draft) => draft.nodePath))) {
    try {
      nodeIdByPath.set(nodePath, (await store.ensureNodeForPath(workspaceId, nodePath)).id);
    } catch {
      // The drafts on this node are counted as failed below.
    }
  }
  const written: string[] = [];
  let failed = 0;
  for (const draft of drafts) {
    const nodeId = nodeIdByPath.get(draft.nodePath);
    try {
      if (!nodeId) throw new Error("node unavailable");
      await store.writeMemory({
        workspaceId,
        nodeId,
        title: draft.title,
        content: draft.content,
        source: "manual",
      });
      written.push(draft.title);
    } catch {
      failed += 1;
    }
  }
  return { written, failed };
}
