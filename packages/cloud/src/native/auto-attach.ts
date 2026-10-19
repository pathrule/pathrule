// SPDX-License-Identifier: Apache-2.0
// A folder attaches itself again to the Cloud workspace this machine already served it from, so
// nobody types `pathrule attach` after a sign-in. An attachment (./workspaces.ts) is a line on this
// machine saying which Cloud workspace serves a folder, and the machine usually knows already: the
// hook index the folder is served from names a workspace id, and when the person can read that
// workspace on the Cloud, that is the answer. Only the CLI restores a binding, and says so on a line
// of its own: the MCP server cannot tell the person, so it binds nothing.
//
// A folder is bound here only when it is a Pathrule Cloud folder (core's resolveFolderMode) with no
// Pathrule Local workspace: a folder set to Local, or one a Local workspace serves, is never moved
// to Cloud behind the person's back (`pathrule setup --cloud` shows what changes first). A folder
// named like one of the person's workspaces is not bound here: only `pathrule setup` and `init`,
// whose plan the person sees, bind by name. `pathrule detach` undoes an attachment either way. No
// organization has to be chosen first: a workspace carries its own.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { pathruleHome } from "@pathrule/core/storage/paths.js";
import {
  resolveFolderMode,
  type FolderModeResolution,
} from "@pathrule/core/workspace/folder-mode.js";

import { nativeCloudConfig } from "./config.js";
import {
  attachNativeWorkspace,
  clearDisplacedFolders,
  nativeWorkspaceFor,
  readNativeWorkspaces,
  type NativeWorkspaceEntry,
} from "./workspaces.js";

/** The person's requests on the Cloud (runtime.ts nativeRequest), read-only here. */
export type AutoAttachRequest = <T>(path: string) => Promise<T>;

interface CloudWorkspace {
  id: string;
  organization_id: string;
  name: string;
}

export interface IndexedFolder {
  workspaceId: string;
  /** The index's root, absolute: what an attachment made from it covers. */
  root: string;
  generatedAt: number;
}

/**
 * The edition serving `cwd` (core's resolveFolderMode), Pathrule Cloud being available when this
 * build or run names one. A Cloud named but misconfigured still counts, so its folders report the
 * error instead of reading Pathrule Local.
 */
export function folderModeHere(cwd: string, env: NodeJS.ProcessEnv): FolderModeResolution {
  let cloudAvailable: boolean;
  try {
    cloudAvailable = nativeCloudConfig(env) !== null;
  } catch {
    cloudAvailable = true;
  }
  return resolveFolderMode(cwd, env, { cloudAvailable });
}

/**
 * Why `folder` may not be bound to a Cloud workspace automatically, or null when it may: it is a
 * Pathrule Cloud folder and no Pathrule Local workspace serves it, kept dormant or not.
 */
export function autoAttachRefusal(folder: FolderModeResolution): string | null {
  if (folder.mode === null)
    return "the folder has both a Pathrule Local and a Pathrule Cloud workspace";
  if (folder.mode === "local")
    return folder.source === "project"
      ? "the folder is set to Pathrule Local"
      : "the folder uses Pathrule Local";
  if (folder.local || folder.dormant.local) return "the folder has a Pathrule Local workspace";
  return null;
}

/**
 * The hook indexes (`cache/<ws>/hook-index.json`) rooted at the nearest root containing `cwd`,
 * newest first: the hook serves the folder from the first (findWorkspaceIndex), the rest are what a
 * re-attachment left behind.
 */
export async function indexedFoldersFor(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<IndexedFolder[]> {
  const cache = join(pathruleHome(env), "cache");
  const at = resolve(cwd);
  let names: string[];
  try {
    names = await readdir(cache);
  } catch {
    return [];
  }
  const found: IndexedFolder[] = [];
  for (const name of names) {
    if (!/^[\w-]{1,160}$/.test(name)) continue;
    let index: { workspace_id?: unknown; workspace_root?: unknown; generated_at?: unknown };
    try {
      index = JSON.parse(
        await readFile(join(cache, name, "hook-index.json"), "utf8"),
      ) as typeof index;
    } catch {
      continue;
    }
    if (index.workspace_id !== name || typeof index.workspace_root !== "string") continue;
    const root = resolve(index.workspace_root);
    const inside = at === root || at.startsWith(root === "/" ? "/" : `${root}/`);
    if (!inside) continue;
    const generated =
      typeof index.generated_at === "string" ? Date.parse(index.generated_at) : Number.NaN;
    found.push({
      workspaceId: name,
      root,
      generatedAt: Number.isFinite(generated) ? generated : 0,
    });
  }
  const nearest = Math.max(...found.map((f) => f.root.length));
  return found
    .filter((f) => f.root.length === nearest)
    .sort((a, b) => b.generatedAt - a.generatedAt);
}

export interface AutoAttachOutcome {
  /** The attachment made, at the index's root. */
  entry: NativeWorkspaceEntry;
}

/** The line a CLI prints when it attached a folder by itself. */
export function autoAttachLine({ entry }: AutoAttachOutcome): string {
  return `Attached ${entry.root} to Pathrule Cloud workspace "${entry.name}" (this machine's index for the folder names it).`;
}

/**
 * Attaches the folder serving `cwd` to the Cloud workspace this machine's hook index names for it,
 * when the person can read that workspace. Null when the folder is attached already, may not be
 * bound automatically (autoAttachRefusal, at the folder and at the index's root), or no index
 * names a workspace the person can read. Asks the Cloud for the person's workspaces, across every
 * organization, only when an index could use them; writes only the attachment file.
 */
export async function autoAttachFolder(input: {
  userId: string;
  request: AutoAttachRequest;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<AutoAttachOutcome | null> {
  const entries = await readNativeWorkspaces(input.userId, input.env);
  if (nativeWorkspaceFor(entries, input.cwd)) return null;
  if (autoAttachRefusal(folderModeHere(input.cwd, input.env))) return null;
  // An index rooted above the folder is bound at its root, which must be free to bind too.
  const indexed = (await indexedFoldersFor(input.cwd, input.env)).filter(
    (folder) => !autoAttachRefusal(folderModeHere(folder.root, input.env)),
  );
  if (indexed.length === 0) return null;
  const organizations = (await input.request<{ items: { id: string }[] }>("/v1/organizations"))
    .items;
  const workspaces: CloudWorkspace[] = [];
  for (const organization of organizations) {
    const { items } = await input.request<{ items: CloudWorkspace[] }>(
      `/v1/organizations/${encodeURIComponent(organization.id)}/workspaces`,
    );
    for (const item of items)
      workspaces.push({ ...item, organization_id: item.organization_id ?? organization.id });
  }
  // The index the folder is served from names its workspace; the person reading it on the Cloud
  // confirms it. The attachment covers the index's root, the whole project, not the subfolder.
  for (const folder of indexed) {
    const workspace = workspaces.find((w) => w.id === folder.workspaceId);
    if (!workspace) continue;
    const before = await readNativeWorkspaces(input.userId, input.env);
    const now = await attachNativeWorkspace(
      input.userId,
      {
        workspace_id: workspace.id,
        organization_id: workspace.organization_id,
        name: workspace.name,
        root: folder.root,
      },
      input.env,
    );
    const entry = now.find((e) => e.workspace_id === workspace.id)!;
    // A folder the attach displaced keeps nothing of the workspace (workspaces.ts clearDisplacedFolders).
    await clearDisplacedFolders(before, entry, input.env);
    return { entry };
  }
  return null;
}
