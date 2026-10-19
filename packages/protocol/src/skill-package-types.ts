// SPDX-License-Identifier: Apache-2.0
export type SkillFileRole = "primary" | "reference" | "template" | "example" | "other_text";
export type SkillFileOrigin = "manual" | "github_snapshot";
export type SkillFileMutability = "editable" | "readonly";
export type SkillPackageStatus = "ok" | "source_missing" | "update_available" | "sync_warning";

export interface SkillFile {
  id: string;
  skillId: string;
  path: string;
  role: SkillFileRole;
  content: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  origin: SkillFileOrigin;
  mutability: SkillFileMutability;
  versionId: string;
  versionNumber: number;
  createdBy: string | null;
  lastEditedBy: string | null;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackageFileInput {
  path: string;
  role: SkillFileRole;
  content: string;
  mimeType: string;
  origin: SkillFileOrigin;
  mutability: SkillFileMutability;
}

export interface SkillPackageMeta {
  sourceUrl: string | null;
  resolvedUrl: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  developer: string | null;
  excludedCount: number;
}

export interface SkillPackageSnapshot {
  files: SkillPackageFileInput[];
  meta: SkillPackageMeta;
  excludedFiles: Array<{ path: string; reason: string }>;
}

export const SKILL_PACKAGE_PRIMARY_PATH = "SKILL.md";
export const SKILL_PACKAGE_MAX_FILES = 80;
export const SKILL_PACKAGE_MAX_TOTAL_BYTES = 1024 * 1024;
export const SKILL_PACKAGE_MAX_FILE_BYTES = 256 * 1024;

const ALLOWED_SKILL_TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
]);

export function normalizeSkillPackagePath(input: string): string | { error: string } {
  const path = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");

  if (!path) {
    return { error: "empty_path" };
  }

  if (path.includes("//")) {
    return { error: "invalid_path_separator" };
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return { error: "invalid_path_segment" };
  }

  if (segments.some((segment) => segment === ".git" || segment === ".env")) {
    return { error: "reserved_path" };
  }

  if (path === ".github/workflows" || path.startsWith(".github/workflows/")) {
    return { error: "reserved_path" };
  }

  return segments.join("/");
}

export function inferSkillFileRole(path: string): SkillFileRole {
  const normalized = normalizeSkillPackagePath(path);
  if (typeof normalized !== "string") {
    return "other_text";
  }

  if (normalized === SKILL_PACKAGE_PRIMARY_PATH) {
    return "primary";
  }

  if (normalized.startsWith("references/")) {
    return "reference";
  }

  if (normalized.startsWith("templates/")) {
    return "template";
  }

  if (normalized.startsWith("examples/")) {
    return "example";
  }

  return "other_text";
}

export function isAllowedSkillTextPath(path: string): boolean {
  const normalized = normalizeSkillPackagePath(path);
  if (typeof normalized !== "string") {
    return false;
  }

  const fileName = normalized.split("/").at(-1) ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : undefined;

  return extension ? ALLOWED_SKILL_TEXT_EXTENSIONS.has(extension) : false;
}

export function isEditableSkillFile(file: Pick<SkillFile, "mutability">): boolean {
  return file.mutability === "editable";
}
