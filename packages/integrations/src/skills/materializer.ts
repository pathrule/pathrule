// SPDX-License-Identifier: Apache-2.0
// Pathrule skill → disk materializer. Writes SKILL.md files into each active
// agent-target's skill folder (.claude/skills/, .cursor/skills/, …) so the
// external tool picks them up via its native loader.
//
// Node-only. Import directly from "./materializer.js" —
// do NOT re-export through the shared barrel (it's consumed by the sandboxed
// preload + renderer).

import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { constants as FS_CONSTS } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

import {
  AGENT_TARGETS,
  filterEffectiveSkillTargets,
  type AgentTargetId,
  type AgentTargetSpec,
} from "@pathrule/core/skills/agent-targets.js";
import { slugifySkillName, slugWithIdSuffix } from "./slug.js";
import {
  emptyManifest,
  hashBody,
  isSafeSkillSlug,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
  type ManifestFileEntry,
} from "./manifest.js";

export interface SkillFileForMaterialize {
  path: string;
  content: string;
  sha256: string;
}

export interface SkillForMaterialize {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: "manual" | "template" | "github_ref";
  githubUrl: string | null;
  contentFetchedAt: string | null;
  files?: SkillFileForMaterialize[];
  /**
   * Optional — when the upstream caller provides it, the materializer groups
   * skills sharing a slug and keeps only the newest. Defense-in-depth in case
   * legacy cloud duplicates slip past the workspace-scoped unique index added
   * in 20260511100000_content_dedup.
   */
  updatedAt?: string | null;
}

export interface MaterializerResult {
  written: number;
  skipped: number;
  removed: number;
  errors: Array<{ skillId: string; message: string }>;
}

export interface SyncOptions {
  workspaceRoot: string;
  activeTargets: AgentTargetId[];
  skills: SkillForMaterialize[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(target: string, body: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, target);
}

function composeSkillMd(skill: SkillForMaterialize): string {
  const body = skill.content ?? "";
  // Skill content already carries frontmatter when authored via skill-creator
  // or fetched from github_ref. If it's missing (legacy row), prepend a
  // minimal frontmatter so the external loader still picks it up.
  if (body.trim().startsWith("---")) return body.endsWith("\n") ? body : `${body}\n`;
  const nameLine = skill.name.replace(/"/g, "'");
  const descLine = (skill.description ?? "").replace(/"/g, "'").replace(/\r?\n/g, " ").trim();
  const fm =
    `---\nname: "${nameLine}"\n` + (descLine ? `description: "${descLine}"\n` : "") + `---\n\n`;
  return `${fm}${body}${body.endsWith("\n") ? "" : "\n"}`;
}

/**
 * Resolve a stable slug for the skill. Re-uses whatever was recorded in the
 * manifest (so renames don't drift) and falls back to name + id suffix for
 * collisions against the current cloud set.
 */
function resolveSlug(
  skill: SkillForMaterialize,
  manifest: Manifest,
  claimedSlugs: Set<string>,
): string {
  const existing = manifest.skills[skill.id]?.slug;
  if (existing && !claimedSlugs.has(existing)) return existing;
  const base = slugifySkillName(skill.name);
  if (base && !claimedSlugs.has(base)) return base;
  return slugWithIdSuffix(skill.name, skill.id);
}

async function removeSkillFromTarget(
  workspaceRoot: string,
  spec: AgentTargetSpec,
  slug: string,
): Promise<void> {
  // Only a skill folder directly under the skills folder, whatever a manifest says.
  if (!isSafeSkillSlug(slug)) return;
  const dir = join(workspaceRoot, spec.skillsDir, slug);
  if (await exists(dir)) {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalizePackageFilePath(filePath: string): string {
  const raw = filePath.trim();
  if (!raw) throw new Error("Package file path is empty");
  if (raw.includes("\\")) throw new Error(`Unsafe package file path: ${filePath}`);
  if (raw.includes("//")) throw new Error(`Unsafe package file path: ${filePath}`);
  if (posix.isAbsolute(raw) || win32.isAbsolute(raw)) {
    throw new Error(`Unsafe package file path: ${filePath}`);
  }
  if (raw.split("/").some((segment) => !segment || segment === "..")) {
    throw new Error(`Unsafe package file path: ${filePath}`);
  }

  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`Unsafe package file path: ${filePath}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`Unsafe package file path: ${filePath}`);
  }
  return normalized;
}

function materializeSkillFiles(skill: SkillForMaterialize): Array<{
  path: string;
  content: string;
  hash: string;
}> {
  if (!skill.files?.length) {
    const content = composeSkillMd(skill);
    return [{ path: "SKILL.md", content, hash: hashBody(content) }];
  }

  const seen = new Set<string>();
  const files = skill.files
    .map((file) => {
      const path = normalizePackageFilePath(file.path);
      if (seen.has(path)) throw new Error(`Duplicate package file path: ${path}`);
      seen.add(path);
      return {
        path,
        content: file.content,
        hash: file.sha256 || hashBody(file.content),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  for (let i = 1; i < files.length; i += 1) {
    const previous = files[i - 1]!;
    const current = files[i]!;
    if (packagePathsConflict(previous.path, current.path)) {
      throw new Error(`Conflicting package file paths: ${previous.path}, ${current.path}`);
    }
  }
  return files;
}

function entryHash(files: ManifestFileEntry[]): string {
  return hashBody(files.map((file) => `${file.path}\0${file.hash}`).join("\n"));
}

function managedFilesForEntry(entry: ManifestEntry): ManifestFileEntry[] {
  return entry.files?.length ? entry.files : [{ path: "SKILL.md", hash: entry.hash }];
}

function packagePathsConflict(oldPath: string, nextPath: string): boolean {
  return (
    oldPath !== nextPath &&
    (oldPath.startsWith(`${nextPath}/`) || nextPath.startsWith(`${oldPath}/`))
  );
}

async function pruneEmptyManagedParents(
  workspaceRoot: string,
  spec: AgentTargetSpec,
  slug: string,
  filePath: string,
): Promise<void> {
  let parent = posix.dirname(filePath);
  while (parent && parent !== ".") {
    try {
      await rmdir(join(workspaceRoot, spec.skillsDir, slug, parent));
    } catch {
      return;
    }
    parent = posix.dirname(parent);
  }
}

async function removeConflictingManagedFiles(
  workspaceRoot: string,
  spec: AgentTargetSpec,
  slug: string,
  prev: ManifestEntry | undefined,
  nextPaths: Set<string>,
): Promise<number> {
  if (!prev) return 0;
  let removed = 0;
  for (const file of managedFilesForEntry(prev)) {
    let safePath: string;
    try {
      safePath = normalizePackageFilePath(file.path);
    } catch {
      continue;
    }
    const conflicts = Array.from(nextPaths).some((nextPath) =>
      packagePathsConflict(safePath, nextPath),
    );
    if (!conflicts) continue;
    const target = join(workspaceRoot, spec.skillsDir, slug, safePath);
    if (await exists(target)) {
      await rm(target, { force: true });
      removed += 1;
      await pruneEmptyManagedParents(workspaceRoot, spec, slug, safePath);
    }
  }
  return removed;
}

async function removeManagedFilesNoLongerPresent(
  workspaceRoot: string,
  spec: AgentTargetSpec,
  slug: string,
  prev: ManifestEntry | undefined,
  nextPaths: Set<string>,
): Promise<number> {
  if (!prev) return 0;
  let removed = 0;
  for (const file of managedFilesForEntry(prev)) {
    let safePath: string;
    try {
      safePath = normalizePackageFilePath(file.path);
    } catch {
      continue;
    }
    if (nextPaths.has(safePath)) continue;
    const target = join(workspaceRoot, spec.skillsDir, slug, safePath);
    if (await exists(target)) {
      await rm(target, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function listTargetSlugs(workspaceRoot: string, spec: AgentTargetSpec): Promise<string[]> {
  const root = join(workspaceRoot, spec.skillsDir);
  if (!(await exists(root))) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Drops skills sharing a slugified name from the input set, keeping the newest
 * by `updatedAt`. Defense-in-depth: the workspace-scoped unique index added in
 * 20260511100000_content_dedup prevents new duplicates, but pre-existing rows
 * fetched by an out-of-date cache could still surface here.
 */
function dedupSkillsBySlug(skills: SkillForMaterialize[]): SkillForMaterialize[] {
  const winners = new Map<string, SkillForMaterialize>();
  for (const skill of skills) {
    const slug = slugifySkillName(skill.name);
    const current = winners.get(slug);
    if (!current) {
      winners.set(slug, skill);
      continue;
    }
    const currentTs = current.updatedAt ? Date.parse(current.updatedAt) : 0;
    const nextTs = skill.updatedAt ? Date.parse(skill.updatedAt) : 0;
    if (nextTs > currentTs) winners.set(slug, skill);
  }
  return Array.from(winners.values());
}

/**
 * Materializes the given cloud skill set to every supported, active agent
 * target under workspaceRoot. Idempotent: unchanged content skips fs writes.
 * Cleans up folders for skills no longer present or targets that were
 * deactivated since the last run.
 */
export async function syncSkillsToDisk(opts: SyncOptions): Promise<MaterializerResult> {
  const { workspaceRoot, activeTargets } = opts;
  const skills = dedupSkillsBySlug(opts.skills);
  const result: MaterializerResult = { written: 0, skipped: 0, removed: 0, errors: [] };

  // Effective = supported minus targets whose skills another active target
  // already delivers (skillsSatisfiedBy). The teardown loop below removes a
  // previously materialized skillsDir when its target drops out of this set.
  const supported = filterEffectiveSkillTargets(activeTargets);
  const manifest = await readManifest(workspaceRoot);

  const claimedSlugs = new Set<string>();
  const nextEntries: Record<string, ManifestEntry> = {};

  for (const skill of skills) {
    try {
      const slug = resolveSlug(skill, manifest, claimedSlugs);
      claimedSlugs.add(slug);

      const files = materializeSkillFiles(skill);
      const fileEntries: ManifestFileEntry[] = files.map((file) => ({
        path: file.path,
        hash: file.hash,
      }));
      const packageFiles = Boolean(skill.files?.length);
      const hash = packageFiles ? entryHash(fileEntries) : (fileEntries[0]?.hash ?? hashBody(""));
      const prev = manifest.skills[skill.id];
      const prevFilesByPath = new Map(
        (prev ? managedFilesForEntry(prev) : []).map((file) => [file.path, file.hash]),
      );
      const nextPaths = new Set(files.map((file) => file.path));

      const writtenTargets: AgentTargetId[] = [];
      for (const spec of supported) {
        const slugChanged = prev && prev.slug !== slug;
        if (slugChanged && prev) {
          await removeSkillFromTarget(workspaceRoot, spec, prev.slug);
        }
        result.removed += await removeConflictingManagedFiles(
          workspaceRoot,
          spec,
          slug,
          slugChanged ? undefined : prev,
          nextPaths,
        );
        for (const file of files) {
          const target = join(workspaceRoot, spec.skillsDir, slug, file.path);
          const prevHash = prevFilesByPath.get(file.path);
          const contentChanged = prevHash !== file.hash;
          const targetMissing = !(await exists(target));
          if (contentChanged || targetMissing || slugChanged) {
            await atomicWrite(target, file.content);
            result.written += 1;
          } else {
            result.skipped += 1;
          }
        }
        result.removed += await removeManagedFilesNoLongerPresent(
          workspaceRoot,
          spec,
          slug,
          slugChanged ? undefined : prev,
          nextPaths,
        );
        writtenTargets.push(spec.id);
      }

      // Tear down folders for targets that were active before but aren't now.
      if (prev) {
        const removedTargets = prev.targets.filter((t) => !writtenTargets.includes(t));
        for (const tid of removedTargets) {
          const spec = AGENT_TARGETS[tid];
          if (!spec) continue;
          await removeSkillFromTarget(workspaceRoot, spec, prev.slug);
          result.removed += 1;
        }
      }

      nextEntries[skill.id] = {
        slug,
        hash,
        source: skill.source,
        fetchedAt: skill.source === "github_ref" ? skill.contentFetchedAt : null,
        targets: writtenTargets,
        ...(packageFiles ? { files: fileEntries } : {}),
      };
    } catch (e) {
      const prev = manifest.skills[skill.id];
      if (prev) nextEntries[skill.id] = prev;
      result.errors.push({
        skillId: skill.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Garbage-collect entries no longer present in the cloud set.
  const liveIds = new Set(skills.map((s) => s.id));
  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (liveIds.has(id)) continue;
    for (const tid of entry.targets) {
      const spec = AGENT_TARGETS[tid];
      if (!spec) continue;
      await removeSkillFromTarget(workspaceRoot, spec, entry.slug);
      result.removed += 1;
    }
  }

  // Orphan sweep: on each supported target, drop folders under skillsDir that
  // correspond to no current manifest entry (left over from manual tampering
  // or crashed prior runs). Only touches folders whose name matches a
  // previously-seen slug to avoid clobbering user-authored skills.
  const knownSlugs = new Set<string>();
  for (const entry of Object.values(nextEntries)) knownSlugs.add(entry.slug);
  for (const entry of Object.values(manifest.skills)) knownSlugs.add(entry.slug);
  for (const spec of supported) {
    const onDisk = await listTargetSlugs(workspaceRoot, spec);
    for (const slug of onDisk) {
      const stillLive = Object.values(nextEntries).some((e) => e.slug === slug);
      if (stillLive) continue;
      if (!knownSlugs.has(slug)) continue;
      await removeSkillFromTarget(workspaceRoot, spec, slug);
      result.removed += 1;
    }
  }

  const next: Manifest = { version: manifest.version, skills: nextEntries };
  await writeManifest(workspaceRoot, next);

  // Opt-in commit strategy: if the workspace has a .gitignore and we haven't
  // added our section yet, append it. Keeps materialized SKILL.md files out
  // of git by default. User can delete the section to commit them.
  if (Object.keys(nextEntries).length > 0) {
    await ensureGitignoreSection(workspaceRoot).catch(() => {
      // Best-effort — gitignore edits must never block a materialize run.
    });
  }

  return result;
}

const GITIGNORE_MARKER = "# Pathrule-managed skills (M18) —";

/** Derived from AGENT_TARGETS so a new agent target can never drift out of
 *  the gitignore section. Note for Copilot: the cloud coding agent only sees
 *  COMMITTED files — users who want skills visible there delete these lines
 *  (the section header documents the opt-in). */
function gitignoreManagedLines(): string[] {
  const dirs = Object.values(AGENT_TARGETS).map((spec) => `${spec.skillsDir}/`);
  return [...dirs, ".claude/.pathrule-skills-manifest.json"];
}

function gitignoreSection(): string {
  return (
    `\n${GITIGNORE_MARKER} cloud is the source of truth.\n` +
    `# Delete the lines below to opt in to committing your materialized skills.\n` +
    `${gitignoreManagedLines().join("\n")}\n`
  );
}

async function ensureGitignoreSection(workspaceRoot: string): Promise<void> {
  const target = join(workspaceRoot, ".gitignore");
  if (!(await exists(target))) return; // don't create a .gitignore; only augment one
  const existing = await readFile(target, "utf8");
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  if (!existing.includes(GITIGNORE_MARKER)) {
    await appendFile(target, (needsLeadingNewline ? "\n" : "") + gitignoreSection(), "utf8");
    return;
  }
  // Section exists from an earlier run — append only lines a newer agent
  // target introduced (e.g. `.github/skills/` for Copilot). Trade-off: a user
  // who deleted a line to opt in to committing skills gets that one line
  // re-appended once when a new target ships; deleting it again sticks.
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = gitignoreManagedLines().filter((line) => !present.has(line));
  if (missing.length === 0) return;
  await appendFile(target, (needsLeadingNewline ? "\n" : "") + `${missing.join("\n")}\n`, "utf8");
}

/** Returns skill ids whose github_ref content is older than the given hours. */
export async function findStaleGithubSkills(
  workspaceRoot: string,
  staleHours: number,
): Promise<string[]> {
  const manifest = await readManifest(workspaceRoot);
  const out: string[] = [];
  const threshold = Date.now() - staleHours * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(manifest.skills)) {
    if (entry.source !== "github_ref") continue;
    if (!entry.fetchedAt) {
      out.push(id);
      continue;
    }
    const ts = new Date(entry.fetchedAt).getTime();
    if (!Number.isFinite(ts) || ts < threshold) out.push(id);
  }
  return out;
}

/** Export for tests / debugging — computes what would be written without touching disk. */
export function __composeForTest(skill: SkillForMaterialize): string {
  return composeSkillMd(skill);
}

export { emptyManifest };
