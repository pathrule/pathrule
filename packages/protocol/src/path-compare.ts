// SPDX-License-Identifier: Apache-2.0
// Filesystem-path comparison helpers that honour platform case-sensitivity.
//
// macOS APFS and Windows NTFS default to case-insensitive, case-preserving.
// Linux ext4 is case-sensitive. Raw `===` / `startsWith` against absolute
// paths drops valid matches on the most common dev platforms — e.g. a row
// stored as `/Users/me/GitHub/repo` and a cwd reported as
// `/Users/me/Github/repo` resolve to the same directory on disk but compare
// false as strings.
//
// Use these helpers wherever absolute filesystem paths are compared:
// MCP workspace matcher, hook supervisor, hook script. Workspace-RELATIVE
// paths (node_path values like `/apps/web`) live only in our own database,
// so they're always exact-compared — case is consistent by construction.

export type FsPlatform = NodeJS.Platform;

/** True on platforms whose default filesystem is case-insensitive. */
export function isCaseInsensitiveFs(platform: FsPlatform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/**
 * Compare key for an absolute path. Strips trailing slashes; lowercases on
 * case-insensitive platforms. Pure string transform — same length as the
 * trailing-slash-stripped input, safe for `.slice(root.length)`.
 */
function compareKey(p: string, platform: FsPlatform = process.platform): string {
  const trimmed = p.replace(/\/+$/, "");
  return isCaseInsensitiveFs(platform) ? trimmed.toLowerCase() : trimmed;
}

/** Case-aware filesystem-path equality with trailing-slash tolerance. */
export function pathsEqual(a: string, b: string, platform: FsPlatform = process.platform): boolean {
  return compareKey(a, platform) === compareKey(b, platform);
}

/**
 * Case-aware filesystem-path prefix check with a hard "/" boundary, so
 * `/foo` does NOT match `/foo-bar`. `parent` may carry a trailing slash;
 * it is normalized.
 */
export function pathStartsWith(
  child: string,
  parent: string,
  platform: FsPlatform = process.platform,
): boolean {
  const c = compareKey(child, platform);
  const p = compareKey(parent, platform);
  if (c === p) return true;
  return c.startsWith(p + "/");
}
