// SPDX-License-Identifier: Apache-2.0
// Disk edge for the recovery planner. The decisions live in @pathrule/core
// (`buildRecoveryPlan`, pure); this walks a workspace and feeds it.
//
// Only paths that could BE a leftover are read, so this stays cheap on a large
// repo: a `backup.*` file beside an instruction file, or anything under
// `.pathrule/backups/`. Nothing is written here: recovery is report-only until
// the user chooses.

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { BACKUP_DIR } from "@pathrule/core/paths/workspace-files.js";
import {
  buildRecoveryPlan,
  type RecoveryPlan,
  type ScannedFile,
} from "@pathrule/core/paths/recovery.js";

/** Directories never worth walking for leftovers. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "Pods",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  "DerivedData",
]);

/** Instruction filenames whose live content decides whether a restore is clean. */
const INSTRUCTION_BASENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "copilot-instructions.md",
]);

const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 512 * 1024;

function isLeftoverName(name: string): boolean {
  return name.startsWith("backup.") || name.startsWith("backup..");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Collect the files the recovery planner needs: every leftover candidate, plus
 * the live instruction files (so the plan can tell a clean restore from one that
 * needs a human choice).
 */
export async function scanForRecovery(workspaceRoot: string): Promise<ScannedFile[]> {
  const found: ScannedFile[] = [];

  const read = async (abs: string): Promise<void> => {
    try {
      const st = await stat(abs);
      if (st.size > MAX_FILE_BYTES) return;
      found.push({ path: toPosix(relative(workspaceRoot, abs)), content: await readFile(abs, "utf8") });
    } catch {
      // Unreadable file: recovery is best-effort, never fatal.
    }
  };

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // `.pathrule` is walked (the vault lives there); other dot dirs are not,
        // except the tool dirs that can hold an instruction file.
        if (entry.name.startsWith(".")) {
          const walkable = [".pathrule", ".claude", ".github", ".cursor", ".windsurf", ".codex"];
          if (!walkable.includes(entry.name)) continue;
        }
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isLeftoverName(entry.name) || INSTRUCTION_BASENAMES.has(entry.name)) {
        await read(abs);
      }
    }
  };

  await walk(workspaceRoot, 0);
  return found;
}

/** Scan a workspace and return what an older Pathrule left behind. */
export async function planRecovery(workspaceRoot: string): Promise<RecoveryPlan> {
  return buildRecoveryPlan(await scanForRecovery(workspaceRoot));
}

export { BACKUP_DIR };
