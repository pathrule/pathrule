// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

export type ManagedFileOwner = "desktop" | "cli" | "mcp";

export type ManagedFileOwnershipStatus =
  | "current"
  | "other_owner"
  | "newer_version"
  | "older_version";

export interface ManagedFileOwnershipEntry {
  path: string;
  owner: ManagedFileOwner;
  owner_version: string;
  updated_at: string;
}

export interface ManagedFileOwnershipManifest {
  schema_version: 1;
  files: ManagedFileOwnershipEntry[];
}

export interface ManagedFileOwnershipSummary extends ManagedFileOwnershipEntry {
  status: ManagedFileOwnershipStatus;
}

const MANIFEST_RELATIVE_PATH = ".pathrule/managed-files.json";

export function managedFileOwnershipManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, MANIFEST_RELATIVE_PATH);
}

export function normalizeManagedFilePath(relativePath: string): string {
  const normalized = normalize(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    normalized === "." ||
    normalized.length === 0 ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid managed file path: ${relativePath}`);
  }
  return normalized;
}

export async function readManagedFileOwnershipManifest(
  workspaceRoot: string,
): Promise<ManagedFileOwnershipManifest> {
  try {
    const raw = await readFile(managedFileOwnershipManifestPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedFileOwnershipManifest>;
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.files)) {
      return emptyManifest();
    }
    const files = parsed.files.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Partial<ManagedFileOwnershipEntry>;
      if (
        typeof candidate.path !== "string" ||
        !isManagedFileOwner(candidate.owner) ||
        typeof candidate.owner_version !== "string" ||
        typeof candidate.updated_at !== "string"
      ) {
        return [];
      }
      try {
        return [
          {
            path: normalizeManagedFilePath(candidate.path),
            owner: candidate.owner,
            owner_version: candidate.owner_version,
            updated_at: candidate.updated_at,
          },
        ];
      } catch {
        return [];
      }
    });
    return { schema_version: 1, files: sortEntries(dedupeEntries(files)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    if (err instanceof SyntaxError) return emptyManifest();
    throw err;
  }
}

export async function recordManagedFileOwnership(opts: {
  workspaceRoot: string;
  paths: readonly string[];
  owner: ManagedFileOwner;
  ownerVersion: string;
  now?: Date;
}): Promise<void> {
  if (opts.paths.length === 0) return;
  const manifest = await readManagedFileOwnershipManifest(opts.workspaceRoot);
  const updatedAt = (opts.now ?? new Date()).toISOString();
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const path of opts.paths) {
    const normalized = normalizeManagedFilePath(path);
    entries.set(normalized, {
      path: normalized,
      owner: opts.owner,
      owner_version: opts.ownerVersion,
      updated_at: updatedAt,
    });
  }
  await writeManifest(opts.workspaceRoot, {
    schema_version: 1,
    files: sortEntries(Array.from(entries.values())),
  });
}

export async function forgetManagedFileOwnership(opts: {
  workspaceRoot: string;
  paths: readonly string[];
}): Promise<void> {
  if (opts.paths.length === 0) return;
  const manifest = await readManagedFileOwnershipManifest(opts.workspaceRoot);
  const forget = new Set(opts.paths.map(normalizeManagedFilePath));
  await writeManifest(opts.workspaceRoot, {
    schema_version: 1,
    files: manifest.files.filter((entry) => !forget.has(entry.path)),
  });
}

export function summarizeManagedFileOwnership(
  manifest: ManagedFileOwnershipManifest,
  currentOwner: ManagedFileOwner,
  currentVersion: string,
): ManagedFileOwnershipSummary[] {
  return manifest.files.map((entry) => ({
    ...entry,
    status: ownershipStatus(entry, currentOwner, currentVersion),
  }));
}

export function compareSemverish(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function ownershipStatus(
  entry: ManagedFileOwnershipEntry,
  currentOwner: ManagedFileOwner,
  currentVersion: string,
): ManagedFileOwnershipStatus {
  if (entry.owner !== currentOwner) return "other_owner";
  const versionCompare = compareSemverish(entry.owner_version, currentVersion);
  if (versionCompare > 0) return "newer_version";
  if (versionCompare < 0) return "older_version";
  return "current";
}

async function writeManifest(
  workspaceRoot: string,
  manifest: ManagedFileOwnershipManifest,
): Promise<void> {
  const target = managedFileOwnershipManifestPath(workspaceRoot);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function emptyManifest(): ManagedFileOwnershipManifest {
  return { schema_version: 1, files: [] };
}

function isManagedFileOwner(value: unknown): value is ManagedFileOwner {
  return value === "desktop" || value === "cli" || value === "mcp";
}

function parseVersionParts(version: string): number[] {
  const match = version.match(/\d+(?:\.\d+)*/);
  if (!match) return [0];
  return match[0].split(".").map((part) => Number.parseInt(part, 10));
}

function dedupeEntries(entries: ManagedFileOwnershipEntry[]): ManagedFileOwnershipEntry[] {
  return Array.from(new Map(entries.map((entry) => [entry.path, entry])).values());
}

function sortEntries(entries: ManagedFileOwnershipEntry[]): ManagedFileOwnershipEntry[] {
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function deleteManagedFileOwnershipManifest(workspaceRoot: string): Promise<void> {
  try {
    await unlink(managedFileOwnershipManifestPath(workspaceRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
