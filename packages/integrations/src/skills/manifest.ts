// SPDX-License-Identifier: Apache-2.0
// On-disk manifest tracking which cloud skills have been materialized to
// which agent-target folders, plus content hash + fetched_at for stale-check.
//
// Node-only — uses node:crypto and node:fs. Not re-exported from the shared
// barrel per the "Node-only modülleri shared barrel'dan re-export etme" rule;
// import directly from "./manifest.js".

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTargetId } from "@pathrule/core/skills/agent-targets.js";

export const MANIFEST_FILENAME = ".pathrule-skills-manifest.json";
export const MANIFEST_VERSION = 2;

export interface ManifestFileEntry {
  /** Workspace-relative package path under the skill slug folder. */
  path: string;
  /** sha256 of the package file body last written to disk. */
  hash: string;
}

export interface ManifestEntry {
  /** Folder slug under <skillsDir>/ — stable across renames so GC works. */
  slug: string;
  /** sha256 of the legacy SKILL.md body, or package file hash summary. */
  hash: string;
  /** 'manual' | 'template' | 'github_ref'. */
  source: string;
  /** ISO timestamp — when we last fetched github_ref body. */
  fetchedAt: string | null;
  /** Which target-id folders we wrote this skill to. */
  targets: AgentTargetId[];
  /** Package files written under the slug folder. Omitted for legacy rows. */
  files?: ManifestFileEntry[];
}

export interface Manifest {
  version: number;
  /** Keyed by skill.id (workspace-wide unique). */
  skills: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, skills: {} };
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".claude", MANIFEST_FILENAME);
}

/**
 * A slug is one folder name, the shape `slugifySkillName` and `slugWithIdSuffix` produce. The
 * manifest sits in the workspace (`.claude/`), where a cloned repository can put anything: a slug
 * like `../../..` would make the next sync delete or write outside the skills folder.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeSkillSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= 100 && SLUG.test(slug);
}

function isValidManifestEntry(entry: unknown): entry is ManifestEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ManifestEntry>;
  return (
    isSafeSkillSlug(candidate.slug) &&
    typeof candidate.hash === "string" &&
    typeof candidate.source === "string" &&
    (candidate.fetchedAt === null || typeof candidate.fetchedAt === "string") &&
    Array.isArray(candidate.targets) &&
    candidate.targets.every((target) => typeof target === "string")
  );
}

function isValidManifestFileEntry(file: unknown): file is ManifestFileEntry {
  if (!file || typeof file !== "object") return false;
  const candidate = file as Partial<ManifestFileEntry>;
  return typeof candidate.path === "string" && typeof candidate.hash === "string";
}

function normalizeManifestSkills(
  skills: unknown,
  version: number,
): Record<string, ManifestEntry> | null {
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return null;
  const normalized: Record<string, ManifestEntry> = {};
  for (const [id, entry] of Object.entries(skills)) {
    if (!isValidManifestEntry(entry)) return null;
    if (version === MANIFEST_VERSION && entry.files !== undefined && !Array.isArray(entry.files)) {
      return null;
    }
    if (
      version === MANIFEST_VERSION &&
      entry.files?.some((file) => !isValidManifestFileEntry(file))
    ) {
      return null;
    }
    normalized[id] = {
      slug: entry.slug,
      hash: entry.hash,
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      targets: entry.targets,
      ...(version === MANIFEST_VERSION && entry.files ? { files: entry.files } : {}),
    };
  }
  return normalized;
}

export async function readManifest(workspaceRoot: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(workspaceRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (!parsed || typeof parsed !== "object") return emptyManifest();
    if (parsed.version !== MANIFEST_VERSION && parsed.version !== 1) return emptyManifest();
    const skills = normalizeManifestSkills(parsed.skills ?? {}, parsed.version);
    if (!skills) return emptyManifest();
    return { version: MANIFEST_VERSION, skills };
  } catch {
    return emptyManifest();
  }
}

export async function writeManifest(workspaceRoot: string, manifest: Manifest): Promise<void> {
  const target = manifestPath(workspaceRoot);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmp, target);
}

/** Hours since fetchedAt — returns Infinity if never fetched. */
export function hoursSinceFetched(entry: ManifestEntry): number {
  if (!entry.fetchedAt) return Infinity;
  const ms = Date.now() - new Date(entry.fetchedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return Infinity;
  return ms / (1000 * 60 * 60);
}

export const GITHUB_REFRESH_STALE_HOURS = 24;
