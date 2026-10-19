// SPDX-License-Identifier: Apache-2.0
// Hook-triggered maintenance for a Pathrule Local workspace, run without any MCP server.
//
//   refreshLocalIndex     the knowledge changed after the hook index was written: write it again from
//                         the store. Only the index under the Pathrule home is rewritten; nothing in
//                         the project, and the index's framing (the protocol and team context the
//                         last sync decided) is carried as it is.
//   drainLearningEvidence what the hook observed (knowledge-observations.jsonl) goes into the store's
//                         evidence through the store's own ingest, the same call `pathrule_log_activity`
//                         makes. The one observation it turns into knowledge is a command lesson from the
//                         transcripts of ended turns (core maintenance/turn-lessons.ts): a failure and the
//                         variant that worked, and a decision the person stated in a prompt (core
//                         maintenance/stated-decisions.ts), saved at the root, after which Claude's rules
//                         folder and the index are written again so the next session starts with it.
//
// Both reach the store through the home's host (its single owner), and both do nothing for anything
// but a Pathrule Local workspace that serves its folder: never a Pathrule Cloud workspace (nothing
// from Cloud sessions enters a Local store), a store with no workspace of its own (one an earlier
// release created under a Cloud workspace's id), a store set aside, or a Local workspace whose
// folder is now a Cloud folder.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { LocalBackend, resolveLocalPrincipal } from "@pathrule/core";
import { learnFromUserWords } from "@pathrule/core/maintenance/stated-decisions.js";
import { learnFromEndedTurns } from "@pathrule/core/maintenance/turn-lessons.js";
import { rerenderMultiClientLocal } from "@pathrule/integrations/client-renderers/pipeline.js";
import { pathruleHome } from "@pathrule/core/storage/paths.js";
import { syncHookIndex } from "@pathrule/integrations/index-writers/hook-index-writer.js";
import { openPersonalIndexEntries } from "@pathrule/core/user-knowledge/user-knowledge-capture.js";
import { userKnowledgeStoreFor } from "@pathrule/core/user-knowledge/user-knowledge-store.js";
import type { HookIndex } from "@pathrule/protocol/hook-index.js";

import { listLocalWorkspaceStores } from "@pathrule/core/backend/local/workspace-stores.js";
import { isCloudWorkspaceId } from "@pathrule/core/workspace/folder-mode.js";

import { folderEdition } from "../capabilities/folder-edition.js";
import { CLI_VERSION } from "../cli-version.js";
import { cliHostSession } from "./host-session.js";

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MIRROR_MARKER = ".mirror";

export interface MaintenanceTarget {
  workspaceId: string;
  workspaceRoot: string;
}

async function readIndex(env: NodeJS.ProcessEnv, workspaceId: string): Promise<HookIndex | null> {
  try {
    return JSON.parse(await readFile(join(pathruleHome(env), "cache", workspaceId, "hook-index.json"), "utf8")) as HookIndex;
  } catch {
    return null;
  }
}

/** The local workspace to maintain: by id (its index names the root), or the one serving `cwd`. */
export async function resolveMaintenanceTarget(
  env: NodeJS.ProcessEnv,
  input: { workspaceId?: string | null; cwd?: string | null },
): Promise<MaintenanceTarget | { error: string }> {
  let workspaceId = input.workspaceId ?? null;
  let workspaceRoot: string | null = null;
  if (workspaceId) {
    if (!WORKSPACE_ID.test(workspaceId)) return { error: "invalid_workspace_id" };
    if (isCloudWorkspaceId(workspaceId, env)) return { error: "cloud_workspace" };
    workspaceRoot = (await readIndex(env, workspaceId))?.workspace_root ?? null;
  } else if (input.cwd) {
    const match = LocalBackend.discoverWorkspaceForCwd(input.cwd, env);
    if (match) {
      workspaceId = match.workspaceId;
      workspaceRoot = match.localRootPath;
    }
  }
  if (!workspaceId || !workspaceRoot) return { error: "no_local_workspace" };
  if (isCloudWorkspaceId(workspaceId, env)) return { error: "cloud_workspace" };
  const storeDir = join(pathruleHome(env), workspaceId);
  if (!existsSync(join(storeDir, "pathrule.db"))) return { error: "no_local_store" };
  if (existsSync(join(storeDir, MIRROR_MARKER))) return { error: "cloud_mirror" };
  if (!listLocalWorkspaceStores(env).some((w) => w.workspaceId === workspaceId)) return { error: "not_a_local_workspace" };
  const folder = folderEdition(workspaceRoot, env);
  if (folder.mode !== "local" || folder.local?.workspaceId !== workspaceId) return { error: "folder_not_local" };
  return { workspaceId, workspaceRoot };
}

export async function refreshLocalIndex(
  env: NodeJS.ProcessEnv,
  target: MaintenanceTarget,
): Promise<{ ok: boolean; error?: string }> {
  const current = await readIndex(env, target.workspaceId);
  const session = cliHostSession(env);
  try {
    const backend = await session.store(target.workspaceId);
    const result = await syncHookIndex({
      backend,
      workspaceId: target.workspaceId,
      workspaceRoot: target.workspaceRoot,
      env,
      ...(typeof current?.protocol === "string" ? { protocol: current.protocol } : {}),
      ...(typeof current?.team_context === "string" ? { teamContext: current.team_context } : {}),
      ...(await openPersonalIndexEntries(userKnowledgeStoreFor({ env }), join(pathruleHome(env), "cache", target.workspaceId), target.workspaceId, [target.workspaceRoot])),
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "index_sync_failed" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.close();
  }
}

export async function drainLearningEvidence(
  env: NodeJS.ProcessEnv,
  target: MaintenanceTarget,
): Promise<{ ok: boolean; observed: number; skipped: number; lessons: number; error?: string }> {
  const cacheDir = join(pathruleHome(env), "cache", target.workspaceId);
  const file = join(cacheDir, "knowledge-observations.jsonl");
  const session = cliHostSession(env);
  try {
    const store = await session.store(target.workspaceId);
    const result = existsSync(file) ? await store.ingestObservationsFromDisk(target.workspaceId, file) : { observed: 0, skipped: 0 };
    const lessons = (await learnFromEndedTurns(store, target.workspaceId, cacheDir)) + (await learnFromUserWords(store, target.workspaceId, cacheDir));
    if (lessons > 0) await refreshAfterLessons(env, store, target);
    return { ok: true, observed: result.observed, skipped: result.skipped, lessons };
  } catch (err) {
    return { ok: false, observed: 0, skipped: 0, lessons: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await session.close();
  }
}

/** New lessons reach the next session: Claude's rules folder (only when the project has one) and the index. */
async function refreshAfterLessons(env: NodeJS.ProcessEnv, store: Awaited<ReturnType<ReturnType<typeof cliHostSession>["store"]>>, target: MaintenanceTarget): Promise<void> {
  if (existsSync(join(target.workspaceRoot, ".claude", "rules", "pathrule"))) {
    await rerenderMultiClientLocal({
      backend: store,
      workspaceId: target.workspaceId,
      workspaceName: (await store.getWorkspaceName(target.workspaceId)) ?? target.workspaceId,
      workspaceRoot: target.workspaceRoot,
      userId: resolveLocalPrincipal(env),
      runtimeOwner: "cli",
      runtimeVersion: CLI_VERSION,
      activeEngines: ["claude-code"],
      resolveChannel: true,
      env,
    });
  }
  const current = await readIndex(env, target.workspaceId);
  await syncHookIndex({
    backend: store,
    workspaceId: target.workspaceId,
    workspaceRoot: target.workspaceRoot,
    env,
    ...(typeof current?.protocol === "string" ? { protocol: current.protocol } : {}),
    ...(typeof current?.team_context === "string" ? { teamContext: current.team_context } : {}),
  });
}
