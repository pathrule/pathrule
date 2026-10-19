// SPDX-License-Identifier: Apache-2.0
// Canonical workspace-path normalizer.
//
// Single source of truth for all four activity-log writers.
// Pure, dependency-free: no node:path, no fs. Runs in Node, Bun, Deno,
// and Workers without filesystem access.
//
// Contract:
//   Input:  raw_path — absolute or relative, POSIX or Windows separators
//           workspace_root — absolute POSIX path, no trailing slash
//   Output: workspace-relative POSIX path with no leading slash, no ./,
//           no .. segments, no trailing slash
//           OR a typed rejection with a machine-readable reason.

export interface NormalizeInput {
  /** Raw path as observed by a writer. Absolute or relative. POSIX or Windows separators. */
  raw_path: string;
  /** Workspace root in absolute POSIX form (e.g. `/Users/x/GitHub/repo`). No trailing slash. */
  workspace_root: string;
}

export interface NormalizeOk {
  ok: true;
  /** Workspace-relative POSIX path. No leading slash, no `./`, no `..`, no trailing slash. */
  path: string;
}

export interface NormalizeReject {
  ok: false;
  /**
   * Why the path was rejected. Used by the lint rule and telemetry.
   * Never bubbled to the agent.
   */
  reason:
    | "outside_workspace_root"
    | "parent_traversal"
    | "empty_after_normalize"
    | "unsupported_scheme";
}

export type NormalizeResult = NormalizeOk | NormalizeReject;

/**
 * Normalize a raw file path to a canonical workspace-relative POSIX string.
 *
 * Steps (applied in order):
 *  1. Replace all `\` with `/`
 *  2. Reject any URL scheme (`file://`, `http://`, …)
 *  3. Strip Windows drive letter (e.g. `C:/` → `/`)
 *  4. Reject any `..` segment
 *  5. Collapse `//` runs, remove `./` segments, strip trailing `/`
 *  6. If the path starts with workspace_root (case-insensitive on darwin/win32,
 *     case-sensitive on linux), strip the prefix
 *  7. Strip any remaining leading `/`
 *  8. Return `empty_after_normalize` if the result is empty
 */
export function normalize_workspace_path(input: NormalizeInput): NormalizeResult {
  const { raw_path, workspace_root } = input;

  // Guard: empty input
  if (typeof raw_path !== "string" || raw_path.trim() === "") {
    return { ok: false, reason: "empty_after_normalize" };
  }

  // Step 1: backslash → forward slash
  let p = raw_path.replace(/\\/g, "/");

  // Step 2: reject URL schemes  (e.g. file://, http://, https://)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) {
    return { ok: false, reason: "unsupported_scheme" };
  }

  // Step 3: strip Windows drive letter (C:/ → /)
  p = p.replace(/^[a-zA-Z]:\//, "/");

  // Step 4: reject parent traversal — any `..` path segment anywhere
  if (/(^|\/)\.\.($|\/)/.test(p)) {
    return { ok: false, reason: "parent_traversal" };
  }

  // Step 5a: collapse multiple consecutive slashes
  p = p.replace(/\/+/g, "/");

  // Step 5b: remove `./` segments (leading and internal)
  // Loop to handle consecutive ./ sequences
  let prev = "";
  while (prev !== p) {
    prev = p;
    p = p.replace(/(^|\/)\.(?=\/|$)/g, "$1");
  }
  // Collapse any new doubled slashes produced by the above
  p = p.replace(/\/+/g, "/");

  // Step 5c: strip trailing slash
  p = p.replace(/\/$/, "");

  // Step 6: strip workspace root prefix (case-insensitive on macOS/Windows)
  // The root loses its drive letter as the path did in step 3, so `C:\repo\src` matches `C:\repo`.
  const normalizedRoot = workspace_root
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:\//, "/")
    .replace(/\/$/, "");
  const isCaseInsensitive =
    typeof process !== "undefined" &&
    (process.platform === "darwin" || process.platform === "win32");
  const rootToCompare = isCaseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const pathToCompare = isCaseInsensitive ? p.toLowerCase() : p;

  if (pathToCompare === rootToCompare) {
    // Path exactly equals the workspace root → empty after stripping
    return { ok: false, reason: "empty_after_normalize" };
  }

  if (pathToCompare.startsWith(rootToCompare + "/")) {
    // Absolute path that starts with workspace root — strip the root prefix.
    p = p.slice(normalizedRoot.length + 1);
  } else if (pathToCompare.startsWith(rootToCompare)) {
    // Starts with root but no separator — shouldn't happen with a proper root but guard it
    p = p.slice(normalizedRoot.length);
  } else if (p.startsWith("/")) {
    // Absolute path that does NOT start with the workspace root.
    //
    // Determine if this is a "workspace-absolute" path (agent wrote
    // `/packages/app/src/foo.ts` meaning the workspace root is implicitly the
    // filesystem root) or a genuinely outside-workspace path.
    //
    // Rule (pure, no FS access):
    //   - If the path shares no initial segments with the workspace root it is
    //     treated as workspace-absolute: strip the leading `/`.
    //   - If the path shares at least one initial segment with the workspace root
    //     but diverges afterward (sibling repo), it is `outside_workspace_root`.
    //
    // Examples with workspace_root = /Users/x/GitHub/pathrule:
    //   /etc/passwd            → no shared prefix with /Users → strip → etc/passwd
    //   /packages/app/...      → no shared prefix with /Users → strip → packages/app/...
    //   /home/runner/other/... → no shared prefix with /Users → strip → home/runner/...
    //   /Users/x/GitHub/other  → shares /Users/x/GitHub/ with root, diverges → outside
    const rootParts = normalizedRoot.split("/").filter(Boolean); // ['Users','x','GitHub','pathrule']
    const pathParts = p.slice(1).split("/").filter(Boolean); // e.g. ['Users','x','GitHub','other','...']

    let sharedPrefixLen = 0;
    for (let i = 0; i < Math.min(rootParts.length - 1, pathParts.length); i++) {
      const rk = isCaseInsensitive ? rootParts[i]!.toLowerCase() : rootParts[i]!;
      const pk = isCaseInsensitive ? pathParts[i]!.toLowerCase() : pathParts[i]!;
      if (rk === pk) {
        sharedPrefixLen = i + 1;
      } else {
        break;
      }
    }

    if (sharedPrefixLen > 0) {
      // Shares at least one segment with the workspace root → sibling/outside
      return { ok: false, reason: "outside_workspace_root" };
    }

    // No shared prefix → workspace-absolute (strip the leading /)
    p = p.slice(1);
  }

  // Step 7: strip any remaining leading /
  p = p.replace(/^\/+/, "");

  // Step 8: final empty check
  if (p === "" || p === ".") {
    return { ok: false, reason: "empty_after_normalize" };
  }

  return { ok: true, path: p };
}

/**
 * Normalize all file paths in a `files_touched` payload.
 * Drops paths that fail normalization and logs the rejection reasons.
 *
 * Returns the normalized payload and a map of drop reasons for telemetry.
 */
export function normalizeFilesTouched(
  // Tolerant by contract: activity logging must NEVER hard-reject or throw on a
  // missing/malformed files_touched (that surfaces as an InvalidParams / tool error
  // the model reads as "fix args and retry", which is the multi-minute retry-loop
  // hang). Accept undefined and any partial/garbage shape; coerce, never crash.
  filesTouched: { total?: number; by_area?: Record<string, string[]> } | undefined | null,
  workspaceRoot: string,
): {
  // `normalized_v1` is this function's signature on its own output: every surviving
  // path is canonical workspace-relative form. The co-change materializer filters
  // on it, so anything that normalizes paths MUST set it and anything that copies a
  // FilesTouched must preserve it.
  normalized: { total: number; by_area: Record<string, string[]>; normalized_v1: true };
  dropped: Record<string, number>;
} {
  const dropped: Record<string, number> = {};
  const by_area: Record<string, string[]> = {};

  const inputAreas = filesTouched?.by_area;
  const entries = inputAreas && typeof inputAreas === "object" ? Object.entries(inputAreas) : [];
  for (const [area, paths] of entries) {
    if (!Array.isArray(paths)) continue;
    const canonicalPaths: string[] = [];
    for (const raw of paths) {
      if (typeof raw !== "string") continue;
      const result = normalize_workspace_path({ raw_path: raw, workspace_root: workspaceRoot });
      if (result.ok) {
        canonicalPaths.push(result.path);
      } else {
        dropped[result.reason] = (dropped[result.reason] ?? 0) + 1;
      }
    }
    // Only include areas that have at least one valid path
    if (canonicalPaths.length > 0) {
      // Deduplicate within each area
      by_area[area] = [...new Set(canonicalPaths)];
    }
  }

  const total = Object.values(by_area).reduce((sum, paths) => sum + paths.length, 0);

  return {
    // normalized_v1: this function just canonicalised every path above, so it is the
    // one place entitled to make the claim. See the note on the return type.
    normalized: { total, by_area, normalized_v1: true },
    dropped,
  };
}
