// SPDX-License-Identifier: Apache-2.0
// Where `pathrule ui` finds the built Local Console, and how it serves a file from there.
//
// The folder is the first that holds an `index.html`:
//   1. `PATHRULE_UI_ASSETS`, when set (and then only it: a person who names a folder means it);
//   2. `dist/ui` of the installed package: beside the bundle's one file (the official CLI, its
//      tarball), or two folders up from this module's own file in dist/local/ui (the npm package,
//      built one module per source; scripts/build-npm-package.mjs copies the build there);
//   3. the monorepo's `packages/local-console/dist`, for a CLI run from its sources.
// None built: the server answers every page with a short note on how to build them.
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_ASSETS_ENV = "PATHRULE_UI_ASSETS";
export const UI_ASSETS_BUILD_COMMAND = "pnpm --filter @pathrule/local-console build";

function hasIndex(dir: string): boolean {
  try {
    return statSync(join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

/** The candidate folders, in the order they are tried. */
export function uiAssetCandidates(
  env: NodeJS.ProcessEnv,
  moduleUrl: string = import.meta.url,
): string[] {
  const named = env[UI_ASSETS_ENV]?.trim();
  if (named) return [resolve(named)];
  const here = dirname(fileURLToPath(moduleUrl));
  const dist = resolve(here, "..", "..");
  return [
    // In the bundle, this module is the bundle file itself.
    join(here, "ui"),
    // In the npm package this module is dist/local/ui/assets.js.
    ...(basename(dist) === "dist" ? [join(dist, "ui")] : []),
    // From the sources: packages/cli/src/local/ui -> packages/local-console/dist.
    resolve(here, "..", "..", "..", "..", "local-console", "dist"),
  ];
}

/** The folder of the built Local Console, or null when none is built. */
export function resolveUiAssetsDir(
  env: NodeJS.ProcessEnv,
  moduleUrl: string = import.meta.url,
): string | null {
  for (const candidate of uiAssetCandidates(env, moduleUrl)) {
    if (hasIndex(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Whether `target` is `root` or inside it. Both absolute. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export type AssetLookup =
  | { kind: "file"; file: string; index: boolean }
  | { kind: "forbidden" }
  | { kind: "bad_request" }
  | { kind: "not_found" };

/**
 * The file a GET path names inside `root`. The path is decoded, resolved, and refused when it
 * leaves `root`, literally or through a symlink. A path that names no file falls back to
 * `index.html` (the console routes in the page), except one whose last segment has an extension,
 * which is a missing asset and answers 404.
 */
export function lookupAsset(root: string, urlPath: string): AssetLookup {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { kind: "bad_request" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { kind: "bad_request" };
  const target = resolve(root, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  if (!isInside(root, target)) return { kind: "forbidden" };
  const index = join(root, "index.html");

  let file: string | null = null;
  try {
    const stat = statSync(target);
    if (stat.isFile()) file = target;
  } catch {
    // Missing: decided below.
  }
  if (!file) {
    const last = decoded.split("/").pop() ?? "";
    if (extname(last) !== "") return { kind: "not_found" };
    return existsSync(index) ? { kind: "file", file: index, index: true } : { kind: "not_found" };
  }
  try {
    if (!isInside(root, realpathSync(file))) return { kind: "forbidden" };
  } catch {
    return { kind: "not_found" };
  }
  return { kind: "file", file, index: file === index };
}

/** The page every path answers while the console is not built. No script, no style. */
export function notBuiltPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pathrule Local Console</title>
</head>
<body>
<h1>Pathrule Local Console</h1>
<p>The console's assets are not built, so there is no page to show yet. <code>pathrule ui</code> is running and its API answers.</p>
<p>Build them from the Pathrule repository with:</p>
<pre>${UI_ASSETS_BUILD_COMMAND}</pre>
<p>Then run <code>pathrule ui</code> again, or point <code>${UI_ASSETS_ENV}</code> at a folder that holds a built <code>index.html</code>.</p>
</body>
</html>
`;
}
