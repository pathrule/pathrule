// SPDX-License-Identifier: Apache-2.0
/**
 * Which edition serves a folder: Pathrule Cloud or Pathrule Local. The one answer every surface
 * uses (the CLI, the MCP server, the hook's index writers, VS Code, runtime events, learning), so
 * two of them can never serve one folder from different sources.
 *
 * - **A folder's own choice** wins: `pathrule setup` or `init` records it in
 *   `<PATHRULE_HOME>/capabilities/folders.json` when the person picks a mode for that project.
 * - **Else what already serves it**: the folder's Local workspace or its Cloud attachment, so a
 *   project set up before choices were recorded keeps the edition it had.
 * - **Else the device default**: what the person chose (`pathrule config set default-mode`,
 *   stored as `setup` in `capabilities/selection.json`), and Pathrule Cloud for an install that
 *   never chose, when the build names a Cloud.
 *
 * The deepest folder decides, so a nested project keeps its own edition. A Local workspace and a
 * Cloud attachment on the same folder with no choice there is a conflict: nothing guesses, and
 * every surface asks the person to choose with `pathrule setup --cloud` or `--local`.
 *
 * A Cloud folder is never served from a Local store, whatever exists on disk: when the Cloud
 * cannot answer (signed out, offline, no access) the caller reports that and stops.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import { pathsEqual, pathStartsWith } from "@pathrule/protocol/path-compare.js";

import { canonicalizePath, discoverWorkspaceStoreForCwd } from "../backend/local/workspace-stores.js";
import type { WorkspaceMatch } from "../backend/inputs.js";
import { PATHRULE_DIR_MODE, PATHRULE_FILE_MODE, pathruleHome } from "../storage/paths.js";

export type FolderMode = "cloud" | "local";

/** How a folder's choice was recorded, for status output only. */
export type FolderChoiceVia = "setup" | "init" | "attach" | "vscode";

/** A project folder's own choice of edition. */
export interface FolderModeChoice {
  /** The project folder, canonical (symlinks resolved), no trailing slash. */
  root: string;
  mode: FolderMode;
  set_at: string;
  via: FolderChoiceVia;
}

/** A folder attached to a Pathrule Cloud workspace on this machine, by any person who signed in. */
export interface CloudFolderBinding {
  workspaceId: string;
  organizationId: string;
  name: string;
  root: string;
}

export interface DeviceDefault {
  mode: FolderMode;
  /** `chosen`: set by the person. `new-install`: never chosen. `no-cloud`: the build names no Cloud. */
  source: "chosen" | "new-install" | "no-cloud";
}

export interface FolderModeResolution {
  cwd: string;
  /** The edition serving the folder; null only when the folder is in conflict. */
  mode: FolderMode | null;
  /** `project`: the folder's own choice. `workspace`: what serves it. `device-default`: neither. */
  source: "project" | "workspace" | "device-default" | "conflict";
  /** The folder whose choice or workspace decided; null when the device default did. */
  root: string | null;
  deviceDefault: DeviceDefault;
  /** The Local workspace serving the folder: set only when `mode` is local. */
  local: WorkspaceMatch | null;
  /** The Cloud attachment serving the folder: set only when `mode` is cloud. */
  cloud: CloudFolderBinding | null;
  /** The other edition's workspace on this folder, kept but never used while the mode stands. */
  dormant: { local: WorkspaceMatch | null; cloud: CloudFolderBinding | null };
  /** Both editions bound to the deciding folder and no choice there. */
  conflict: { root: string; localWorkspaceId: string; cloudWorkspaceId: string } | null;
}

export interface ResolveFolderModeOptions {
  /** Whether this composition can serve Pathrule Cloud (the build or the run names one). */
  cloudAvailable: boolean;
  /** Test seam: the Local store discovery. */
  discoverLocal?: (cwd: string, env: NodeJS.ProcessEnv) => WorkspaceMatch | null;
}

const CHOICES_FILE = "folders.json";
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

function capabilitiesDir(env: NodeJS.ProcessEnv): string {
  return join(pathruleHome(env), "capabilities");
}

export function folderChoicesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(capabilitiesDir(env), CHOICES_FILE);
}

/** Every recorded folder choice; none when the file is missing or does not read. */
export function readFolderChoices(env: NodeJS.ProcessEnv = process.env): FolderModeChoice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(folderChoicesPath(env), "utf8"));
  } catch {
    return [];
  }
  const file = raw as { schema?: unknown; folders?: unknown } | null;
  if (!file || file.schema !== 1 || !Array.isArray(file.folders)) return [];
  return file.folders.filter(
    (f): f is FolderModeChoice =>
      !!f &&
      typeof f.root === "string" &&
      isAbsolute(f.root) &&
      (f.mode === "cloud" || f.mode === "local") &&
      typeof f.set_at === "string" &&
      typeof f.via === "string",
  );
}

/**
 * Records `root`'s choice, replacing an earlier one for the same folder. Atomic (a temporary file
 * renamed over the old one); a choice is written by a person's command, so writers do not race.
 */
export function recordFolderChoice(
  env: NodeJS.ProcessEnv,
  root: string,
  mode: FolderMode,
  via: FolderChoiceVia,
  now: Date = new Date(),
): FolderModeChoice {
  const canonical = canonicalizePath(root);
  const choice: FolderModeChoice = { root: canonical, mode, set_at: now.toISOString(), via };
  const kept = readFolderChoices(env).filter((c) => !pathsEqual(c.root, canonical));
  writeChoices(env, [...kept, choice]);
  return choice;
}

/** Removes `root`'s own choice, so what serves it (or the device default) decides again. */
export function forgetFolderChoice(env: NodeJS.ProcessEnv, root: string): void {
  const canonical = canonicalizePath(root);
  const all = readFolderChoices(env);
  const kept = all.filter((c) => !pathsEqual(c.root, canonical));
  if (kept.length !== all.length) writeChoices(env, kept);
}

function writeChoices(env: NodeJS.ProcessEnv, folders: FolderModeChoice[]): void {
  const dir = capabilitiesDir(env);
  mkdirSync(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
  const tmp = join(dir, `.${CHOICES_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, folders }, null, 2)}\n`, {
      mode: PATHRULE_FILE_MODE,
    });
    renameSync(tmp, folderChoicesPath(env));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The device default: the mode stored as `setup` in `capabilities/selection.json` when the person
 * chose one, else Pathrule Cloud when this composition can serve it, else Local.
 */
export function readDeviceDefault(
  env: NodeJS.ProcessEnv,
  options: { cloudAvailable: boolean },
): DeviceDefault {
  try {
    const raw = JSON.parse(readFileSync(join(capabilitiesDir(env), "selection.json"), "utf8")) as {
      schema?: unknown;
      setup?: unknown;
    };
    if (raw?.schema === 1 && (raw.setup === "cloud" || raw.setup === "local")) {
      return { mode: raw.setup, source: "chosen" };
    }
  } catch {
    // No choice on file.
  }
  return options.cloudAvailable
    ? { mode: "cloud", source: "new-install" }
    : { mode: "local", source: "no-cloud" };
}

/**
 * Every folder attached to a Pathrule Cloud workspace on this machine, read from each person's
 * `config/users/<hash>/native-workspaces.json` (written by packages/cloud/src/native/workspaces.ts;
 * that module's tests read this reader's answer back). Read without a session: a Cloud folder stays
 * a Cloud folder while its person is signed out.
 */
export function readCloudFolderBindings(env: NodeJS.ProcessEnv = process.env): CloudFolderBinding[] {
  const usersDir = join(pathruleHome(env), "config", "users");
  let users: string[];
  try {
    users = readdirSync(usersDir);
  } catch {
    return [];
  }
  const out: CloudFolderBinding[] = [];
  for (const user of users) {
    let parsed: { schema_version?: unknown; workspaces?: unknown };
    try {
      parsed = JSON.parse(readFileSync(join(usersDir, user, "native-workspaces.json"), "utf8"));
    } catch {
      continue;
    }
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.workspaces)) continue;
    for (const e of parsed.workspaces as Array<Record<string, unknown>>) {
      if (
        typeof e?.workspace_id === "string" &&
        ID.test(e.workspace_id) &&
        typeof e.organization_id === "string" &&
        typeof e.root === "string" &&
        isAbsolute(e.root)
      ) {
        out.push({
          workspaceId: e.workspace_id,
          organizationId: e.organization_id,
          name: typeof e.name === "string" ? e.name : e.workspace_id,
          root: canonicalizePath(e.root),
        });
      }
    }
  }
  return out;
}

/** Whether `id` names a Pathrule Cloud workspace attached on this machine. */
export function isCloudWorkspaceId(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readCloudFolderBindings(env).some((b) => b.workspaceId === id);
}

function covers(root: string, cwd: string): boolean {
  return pathsEqual(cwd, root) || pathStartsWith(cwd, root);
}

function deepest<T extends { root: string }>(items: readonly T[], cwd: string): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (covers(item.root, cwd) && (!best || item.root.length > best.root.length)) best = item;
  }
  return best;
}

/** The edition and workspace that serve `cwd`. Reads files only: no network, no store opened for writing. */
export function resolveFolderMode(
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: ResolveFolderModeOptions,
): FolderModeResolution {
  const at = canonicalizePath(cwd);
  const deviceDefault = readDeviceDefault(env, options);
  const cloudBindings = readCloudFolderBindings(env);
  const cloudIds = new Set(cloudBindings.map((b) => b.workspaceId));
  const discovered = (options.discoverLocal ?? discoverWorkspaceStoreForCwd)(at, env);
  // A store named by a Cloud workspace id is a copy of that workspace's data, never a Local workspace.
  const local = discovered && !cloudIds.has(discovered.workspaceId) ? discovered : null;
  const cloud = deepest(cloudBindings, at);
  const choice = deepest(readFolderChoices(env), at);

  const base = { cwd: at, deviceDefault };
  const localRoot = local ? canonicalizePath(local.localRootPath) : null;
  const depth = Math.max(choice?.root.length ?? -1, localRoot?.length ?? -1, cloud?.root.length ?? -1);
  if (depth < 0) {
    return {
      ...base,
      mode: deviceDefault.mode,
      source: "device-default",
      root: null,
      local: null,
      cloud: null,
      dormant: { local: null, cloud: null },
      conflict: null,
    };
  }
  const served = (mode: FolderMode, source: "project" | "workspace", root: string): FolderModeResolution => ({
    ...base,
    mode,
    source,
    root,
    local: mode === "local" ? local : null,
    cloud: mode === "cloud" ? cloud : null,
    dormant: { local: mode === "cloud" ? local : null, cloud: mode === "local" ? cloud : null },
    conflict: null,
  });
  if (choice && choice.root.length === depth) return served(choice.mode, "project", choice.root);
  const localHere = localRoot?.length === depth;
  const cloudHere = cloud?.root.length === depth;
  if (localHere && cloudHere) {
    return {
      ...base,
      mode: null,
      source: "conflict",
      root: cloud!.root,
      local: null,
      cloud: null,
      dormant: { local, cloud },
      conflict: { root: cloud!.root, localWorkspaceId: local!.workspaceId, cloudWorkspaceId: cloud!.workspaceId },
    };
  }
  return localHere ? served("local", "workspace", localRoot!) : served("cloud", "workspace", cloud!.root);
}

/**
 * Whether anything on this machine is served by Pathrule Cloud: the device default, a folder's
 * choice, or an attachment. A machine that answers no runs the open CLI alone and loads nothing for
 * Cloud.
 */
export function machineUsesCloud(env: NodeJS.ProcessEnv, options: { cloudAvailable: boolean }): boolean {
  if (readDeviceDefault(env, options).mode === "cloud") return true;
  if (readFolderChoices(env).some((c) => c.mode === "cloud")) return true;
  return readCloudFolderBindings(env).length > 0;
}

/** The sentence every surface shows for a folder in conflict. */
export function folderConflictMessage(conflict: NonNullable<FolderModeResolution["conflict"]>): string {
  return (
    `${conflict.root} has both a Pathrule Local workspace and a Pathrule Cloud workspace, and no choice ` +
    `between them. Choose one for this folder: \`pathrule setup --cloud\` or \`pathrule setup --local\`.`
  );
}

/** Whether a Local store directory exists for `id` (used before opening one, so none is created). */
export function localStoreExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return ID.test(id) && existsSync(join(pathruleHome(env), id, "pathrule.db"));
}
