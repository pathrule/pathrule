// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for "is this path segment a directory or a file?".
//
// Pathrule targets any repository, so this cannot lean on web/TS naming.
// Three call sites previously carried their own copy of an extension-length
// regex (`\.[A-Za-z0-9]{1,8}$`), which classified `.gitignore`,
// `MyApp.entitlements`, `Main.storyboard`, and `gradle.properties` as
// directories, failing on essentially every iOS and Android repo.
//
// Bias: when unsure, answer FILE. A wrong "directory" verdict makes callers
// place a path-scoped knowledge file *inside* something that is really a file
// (`.gitignore/CLAUDE.md`). A wrong "file" verdict only folds that path's
// knowledge up into its parent directory: coarser, never invalid.
//
// Pure, dependency-free, deterministic.

/**
 * Extensions that the OS or a toolchain presents as a directory even though
 * they read like a file suffix.
 */
const DIRECTORY_BUNDLE_EXTENSIONS = new Set([
  "app",
  "bundle",
  "docset",
  "framework",
  "kext",
  "lproj",
  "playground",
  "plugin",
  "prefpane",
  "xcassets",
  "xcodeproj",
  "xcworkspace",
]);

/**
 * Leading-dot names that are DIRECTORIES rather than config files. This set is
 * closed and enumerable (tool directories), while dotfiles are open-ended
 * (`.gitignore`, `.editorconfig`, some future `.newtoolrc`), so we list the
 * closed set and treat every other dot-name as a file.
 */
const DOT_DIRECTORIES = new Set([
  "cache",
  "claude",
  "codex",
  "config",
  "cursor",
  "devin",
  "expo",
  "git",
  "github",
  "gitlab",
  "gradle",
  "husky",
  "idea",
  "next",
  "nuxt",
  "pathrule",
  "pnpm",
  "svelte-kit",
  "venv",
  "vscode",
  "windsurf",
  "yarn",
]);

/** True when this single path SEGMENT names a directory. */
export function isDirectoryLeafName(name: string): boolean {
  if (name === "") return true;

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0) return true; // no dot at all
  const suffix = name.slice(dotIndex + 1).toLowerCase();
  if (suffix === "") return true; // trailing dot is not an extension

  if (dotIndex === 0) return DOT_DIRECTORIES.has(suffix);
  return DIRECTORY_BUNDLE_EXTENSIONS.has(suffix);
}

/** The last non-empty segment of a workspace-relative path. */
export function lastSegment(relativePath: string): string {
  const segments = relativePath.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? "";
}

/** True when the path's final segment names a directory (or the path is root). */
export function isDirectoryPath(relativePath: string): boolean {
  return isDirectoryLeafName(lastSegment(relativePath));
}
