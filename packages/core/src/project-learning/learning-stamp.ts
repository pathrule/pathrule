// SPDX-License-Identifier: Apache-2.0
//
// The change stamp that lets a context cache notice a learning claim was recorded, revised
// or retracted. The host's turn context and the MCP get_context tool both key their caches on
// it, so a changed claim is never served from an older load.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  localRuntimePaths,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "../storage/paths.js";

const WORKSPACE_ID = /^[\w-]{1,160}$/;

function learningDir(workspaceId: string, env: NodeJS.ProcessEnv): string | null {
  if (!WORKSPACE_ID.test(workspaceId)) return null;
  return join(localRuntimePaths(env).home, "cache", workspaceId, "project-learning");
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PATHRULE_DIR_MODE });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body, { encoding: "utf8", mode: PATHRULE_FILE_MODE });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Bump the stamp after a claim is recorded, revised or retracted. Best effort: a stamp
 * that fails to move only delays a cached context until its TTL, it never loses a write.
 */
export async function noteLearningChanged(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = learningDir(workspaceId, env);
  if (!dir) return;
  await writeAtomic(join(dir, "learning.stamp"), `${Date.now()}:${randomUUID()}`).catch(() => {});
}

/** The current stamp, or "" when nothing was ever recorded here. Cheap enough per turn. */
export async function readLearningStamp(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = learningDir(workspaceId, env);
  if (!dir) return "";
  try {
    return await readFile(join(dir, "learning.stamp"), "utf8");
  } catch {
    return "";
  }
}
