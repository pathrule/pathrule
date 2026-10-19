// SPDX-License-Identifier: Apache-2.0
// Local (no-login) workspace init.
//
// `pathrule init --local` creates a workspace and binds it to the current
// folder: it stands up the SQLite store at `~/.pathrule/<id>/pathrule.db` and
// registers the folder as its root so `discoverWorkspaceForCwd` can map a cwd
// back to it. The store is the home's Pathrule host's (./host-session.ts). It imports the project's existing instruction files (CLAUDE.md,
// AGENTS.md, tool rules, decision records) word for word, as the Cloud setup does when it
// binds a folder. Hooks + AI-tool MCP wiring are left to `setup --local`.
//
// Idempotent: if a local workspace already covers this cwd, we reuse it instead
// of creating a duplicate store.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { InstructionImportMode } from "@pathrule/core/knowledge-import/drafts.js";
import type { RemoteStore } from "@pathrule/host/remote-store.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";
// Deep import, NOT the barrel. This file is inside the OSS export closure, and the
// closure is the full import graph: one barrel import re-exports proprietary modules
// into it, which is dozens of closure violations and a failing `release:security-gates`
// for the sake of one function.
import { errorMessage } from "@pathrule/protocol/failure-class.js";
import { withCliHostSession } from "./host-session.js";
import {
  importLocalInstructions,
  type LocalInstructionImport,
} from "./instruction-import-local.js";

export interface InitLocalResult {
  workspaceId: string;
  name: string;
  localRootPath: string;
  /** "created" a new store, or "exists" when a local workspace already covered the cwd. */
  action: "created" | "exists";
  /** The project's instruction files and what this run imported; null when the folder has none. */
  instructions: LocalInstructionImport | null;
}

export interface InitLocalOptions {
  cwd: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * How to import the instruction files. Default: a new workspace takes every file
   * (`missing`), an existing one only while it is still empty (`ifEmpty`).
   * `setup --local --import-instructions` passes `missing` for an existing one.
   */
  instructionImport?: InstructionImportMode;
  /** Test seam — defaults to randomUUID. */
  genWorkspaceId?: () => string;
}

function defaultLocalWorkspaceName(cwd: string): string {
  return basename(cwd.replace(/\/+$/, "")) || "workspace";
}

export async function initLocalWorkspace(options: InitLocalOptions): Promise<InitLocalResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd.replace(/\/+$/, "");

  return withCliHostSession(env, async (session) => {
    // Idempotent: a folder already inside a local workspace reuses it.
    const existing = session.resolveLocal(cwd);
    if (existing) {
      const backend = await session.store(existing.workspaceId);
      const instructions = await importInstructions(
        backend,
        existing.workspaceId,
        existing.root,
        options.instructionImport ?? "ifEmpty",
      );
      // The index was warmed when the workspace was created; only new memories make it stale.
      if (instructions && instructions.imported > 0) {
        await warmHookIndex(backend, existing.workspaceId, existing.root, env);
      }
      return {
        workspaceId: existing.workspaceId,
        name: options.name ?? defaultLocalWorkspaceName(existing.root),
        localRootPath: existing.root,
        action: "exists",
        instructions,
      };
    }

    const workspaceId = (options.genWorkspaceId ?? (() => randomUUID()))();
    const name = options.name ?? defaultLocalWorkspaceName(cwd);
    const backend = await session.store(workspaceId);
    await backend.registerWorkspace({ workspaceId, name, localRootPath: cwd });
    // Before the warm-up, so the first prompt already carries what was imported.
    const instructions = await importInstructions(
      backend,
      workspaceId,
      cwd,
      options.instructionImport ?? "missing",
    );
    await warmHookIndex(backend, workspaceId, cwd, env);
    return { workspaceId, name, localRootPath: cwd, action: "created", instructions };
  });
}

/** Best-effort: init must not fail on the import, but a failure must not be silent either. */
async function importInstructions(
  backend: RemoteStore,
  workspaceId: string,
  workspaceRoot: string,
  mode: InstructionImportMode,
): Promise<LocalInstructionImport | null> {
  try {
    return await importLocalInstructions({ backend, workspaceId, workspaceRoot, mode });
  } catch (err: unknown) {
    process.stderr.write(
      `[pathrule] importing instruction files failed: ${errorMessage(err, "unknown error")}\n`,
    );
    return null;
  }
}

/**
 * Warm the offline hook-index so PreToolUse/UserPromptSubmit inject path context
 * from the very first prompt (no daemon locally). Best-effort — init must not fail
 * on it, but it must not be SILENT either: syncHookIndex REPORTS failure via
 * { ok: false, error } and only throws on a genuine disk error, so a bare .catch()
 * left the most likely failure invisible and the first prompts uninjected with no trace.
 */
async function warmHookIndex(
  backend: RemoteStore,
  workspaceId: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await syncHookIndex({ backend, workspaceId, workspaceRoot, env })
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(
          `[pathrule] hook-index warm-up reported failure: ${result.error ?? "no payload returned"}\n`,
        );
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[pathrule] hook-index warm-up threw: ${errorMessage(err, "unknown error")}\n`,
      );
    });
}
