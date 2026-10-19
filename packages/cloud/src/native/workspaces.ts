// SPDX-License-Identifier: Apache-2.0
// The folders a person attached to Pathrule Cloud workspaces on this machine: one file per person,
// `<PATHRULE_HOME>/config/users/<hash>/native-workspaces.json` (0600), beside the person's config.
// Folder paths never leave the machine; the Cloud only learns the workspace each request names.
//
// A folder belongs to one workspace, and a workspace to one folder: the hook finds a workspace by
// its index's root (`cache/<workspace>/hook-index.json`), so a second folder replaces the first.
// The mapping names the Cloud workspace on both sides (`localWorkspaceId` = `cloudWorkspaceId`),
// which is the id the host, the MCP server and the hook index use.
//
// Core reads this file without a session (workspace/folder-mode.ts readCloudFolderBindings) to
// decide which edition serves a folder; roots are canonical (symlinks resolved) on both sides, so
// both answer the same for a folder reached through a symlink.
import { pathStartsWith } from "@pathrule/protocol/path-compare.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { serializeByPath } from "@pathrule/core/storage/atomic-write.js";
import {
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
  userRuntimePaths,
} from "@pathrule/core/storage/paths.js";

import type { NativeWorkspaceMapping } from "./account.js";

export const NATIVE_WORKSPACES_SCHEMA_VERSION = 1;

/** One attached folder. */
export interface NativeWorkspaceEntry {
  workspace_id: string;
  organization_id: string;
  /** The workspace's name when it was attached, for messages only. */
  name: string;
  /** The checkout, absolute. */
  root: string;
  attached_at: string;
}

interface NativeWorkspacesFile {
  schema_version: typeof NATIVE_WORKSPACES_SCHEMA_VERSION;
  workspaces: NativeWorkspaceEntry[];
}

const ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * `path`, absolute, symlinks resolved and no trailing slash: core's canonicalizePath, which this
 * module does not import because its module loads SQLite (VS Code reads attachments too).
 */
export function canonical(path: string): string {
  const absolute = resolve(path);
  let real = absolute;
  try {
    real = realpathSync.native(absolute);
  } catch {
    // A folder that is gone or unreadable keeps the path it was given.
  }
  if (/^[A-Za-z]:[\\/]?$/.test(real)) return real;
  return real.replace(/[\\/]+$/, "") || "/";
}

export function nativeWorkspacesFile(userId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(userRuntimePaths(userId, 0, env).userConfigDir, "native-workspaces.json");
}

function valid(entry: unknown): entry is NativeWorkspaceEntry {
  const e = entry as Partial<NativeWorkspaceEntry> | null;
  return (
    !!e &&
    typeof e.workspace_id === "string" &&
    ID.test(e.workspace_id) &&
    typeof e.organization_id === "string" &&
    ID.test(e.organization_id) &&
    typeof e.name === "string" &&
    typeof e.root === "string" &&
    isAbsolute(e.root) &&
    typeof e.attached_at === "string"
  );
}

/** The person's attached folders; none when the file is missing or does not read. */
export async function readNativeWorkspaces(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeWorkspaceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(nativeWorkspacesFile(userId, env), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NativeWorkspacesFile>;
    if (parsed.schema_version !== NATIVE_WORKSPACES_SCHEMA_VERSION) return [];
    return Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(valid) : [];
  } catch {
    return [];
  }
}

async function write(userId: string, entries: NativeWorkspaceEntry[], env: NodeJS.ProcessEnv) {
  const file = nativeWorkspacesFile(userId, env);
  if (entries.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true, mode: PATHRULE_DIR_MODE });
  const body: NativeWorkspacesFile = {
    schema_version: NATIVE_WORKSPACES_SCHEMA_VERSION,
    workspaces: entries,
  };
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: PATHRULE_FILE_MODE });
  await chmod(tmp, PATHRULE_FILE_MODE).catch(() => {});
  await rename(tmp, file);
}

/**
 * Attach `root` to a workspace: the folder's earlier workspace, and the workspace's earlier folder,
 * are replaced. Returns the entries now on file.
 */
export async function attachNativeWorkspace(
  userId: string,
  entry: Omit<NativeWorkspaceEntry, "attached_at" | "root"> & { root: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeWorkspaceEntry[]> {
  if (!ID.test(entry.workspace_id) || !ID.test(entry.organization_id))
    throw new Error("not a Pathrule Cloud workspace id");
  const root = canonical(entry.root);
  return serializeByPath(nativeWorkspacesFile(userId, env), async () => {
    const kept = (await readNativeWorkspaces(userId, env)).filter(
      (e) => canonical(e.root) !== root && e.workspace_id !== entry.workspace_id,
    );
    const next = [...kept, { ...entry, root, attached_at: new Date().toISOString() }];
    await write(userId, next, env);
    return next;
  });
}

/**
 * One attachment per workspace and per folder, so an attach can displace one: the folder the workspace
 * served before, or the workspace this folder had. What that workspace rendered into a folder it no
 * longer serves goes, as on detach (integrations clear-knowledge.ts), or an agent there keeps reading it.
 * A folder set to Pathrule Local keeps its files: they are its Local knowledge. Call with the entries
 * read before the attach; returns what each displaced folder lost, for the caller to say.
 */
export async function clearDisplacedFolders(
  before: readonly NativeWorkspaceEntry[],
  attached: Pick<NativeWorkspaceEntry, "root" | "workspace_id">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ entry: NativeWorkspaceEntry; cleared: DetachCleanup["knowledge"] }>> {
  const out: Array<{ entry: NativeWorkspaceEntry; cleared: DetachCleanup["knowledge"] }> = [];
  for (const old of before) {
    if ((old.root === attached.root) === (old.workspace_id === attached.workspace_id)) continue;
    const { readFolderChoices } = await import("@pathrule/core/workspace/folder-mode.js");
    if (readFolderChoices(env).some((c) => c.mode === "local" && canonical(c.root) === old.root)) continue;
    out.push({ entry: old, cleared: await clearRenderedKnowledge(old.root) });
  }
  return out;
}

/** Detach the folder that serves `cwd` (the longest attached root containing it); null when none. */
export function detachNativeWorkspace(
  userId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeWorkspaceEntry | null> {
  return serializeByPath(nativeWorkspacesFile(userId, env), async () => {
    const entries = await readNativeWorkspaces(userId, env);
    const served = nativeWorkspaceFor(entries, cwd);
    if (!served) return null;
    await write(
      userId,
      entries.filter((e) => e !== served),
      env,
    );
    return served;
  });
}

/**
 * The attached folder that serves `cwd`: the longest root containing it, both sides canonical, as
 * core's resolveFolderMode compares them.
 */
export function nativeWorkspaceFor(
  entries: readonly NativeWorkspaceEntry[],
  cwd: string,
): NativeWorkspaceEntry | null {
  const at = canonical(cwd);
  let best: { entry: NativeWorkspaceEntry; root: string } | null = null;
  for (const e of entries) {
    const root = canonical(e.root);
    const inside = pathStartsWith(at, root);
    if (inside && (!best || root.length > best.root.length)) best = { entry: e, root };
  }
  return best?.entry ?? null;
}

/** The mappings the native composition takes, one per attached folder. */
export function nativeMappings(entries: readonly NativeWorkspaceEntry[]): NativeWorkspaceMapping[] {
  return entries.map((e) => ({
    localWorkspaceId: e.workspace_id,
    cloudWorkspaceId: e.workspace_id,
    cloudOrganizationId: e.organization_id,
    localRootPath: e.root,
  }));
}

/** What a detach removed from this machine besides the attachment. */
export interface DetachCleanup {
  /** This machine's cache of the workspace: entries removed, or why it was kept. */
  cache: { removed: number; kept: string | null };
  /**
   * Pathrule's rendered knowledge in the folder: files removed, files that are the person's and had
   * only Pathrule's block taken out, and what could not be changed.
   */
  knowledge: { removed: number; stripped: number; unclear: Array<{ path: string; reason: string }>; errors: string[] };
}

/**
 * Removes what this machine keeps of a Pathrule Cloud workspace once `entry` was detached, so
 * nothing from Pathrule Cloud stays usable here: its machine cache (core's removeCloudMachineCache:
 * the hook index and session caches; delivery receipts not reported yet stay), and, with
 * `knowledge`, the knowledge Pathrule rendered from it into the folder: `.claude/rules/pathrule/`
 * and every file the folder's ledger (`.pathrule/managed-files.json`) records that carries
 * Pathrule's knowledge banner. The person's own files and the hook entries stay; a file of theirs
 * holding a Pathrule block keeps everything but the block (the sync's own sweep, disk-writer.ts).
 *
 * The cache stays when another attachment on this machine still names the workspace, or when its
 * id is a Pathrule Local workspace's. Call after detachNativeWorkspace. Never throws.
 */
export async function clearDetachedFolder(
  entry: NativeWorkspaceEntry,
  env: NodeJS.ProcessEnv,
  options: { knowledge: boolean },
): Promise<DetachCleanup> {
  return {
    cache: await clearMachineCache(entry.workspace_id, env),
    knowledge: options.knowledge
      ? await clearRenderedKnowledge(entry.root)
      : { removed: 0, stripped: 0, unclear: [], errors: [] },
  };
}

async function clearMachineCache(
  workspaceId: string,
  env: NodeJS.ProcessEnv,
): Promise<DetachCleanup["cache"]> {
  try {
    // Loaded here: these modules open SQLite stores, which nothing else in this module needs.
    const { readCloudFolderBindings } = await import("@pathrule/core/workspace/folder-mode.js");
    if (readCloudFolderBindings(env).some((b) => b.workspaceId === workspaceId))
      return { removed: 0, kept: "another attachment on this machine still uses it" };
    const { removeCloudMachineCache } =
      await import("@pathrule/core/workspace/local-store-markers.js");
    const { listLocalWorkspaceStores } =
      await import("@pathrule/core/backend/local/workspace-stores.js");
    const isLocalWorkspace = (id: string) =>
      listLocalWorkspaceStores(env).some((store) => store.workspaceId === id);
    return {
      removed: removeCloudMachineCache(env, workspaceId, isLocalWorkspace).length,
      kept: null,
    };
  } catch (err) {
    return { removed: 0, kept: err instanceof Error ? err.message : String(err) };
  }
}

async function clearRenderedKnowledge(root: string): Promise<DetachCleanup["knowledge"]> {
  // Shared with the move to Pathrule Local (cli capabilities/folder-setup.ts): one definition of what a
  // folder keeps once a Cloud workspace no longer serves it.
  const { clearRenderedKnowledge: clear } = await import("@pathrule/integrations/client-renderers/clear-knowledge.js");
  return clear(root);
}
