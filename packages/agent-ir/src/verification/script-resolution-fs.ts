// SPDX-License-Identifier: Apache-2.0
/**
 * Collect package.json scripts from a workspace root, for `resolveScriptCommand`.
 *
 * Separate module because it touches `node:fs`, and the pure resolver must stay reachable
 * from the remote MCP in Pathrule Cloud, which has no repo filesystem. Deliberately NOT re-exported
 * from the package barrel: a surface that cannot read the repo should not be able to
 * import this by accident and then fail at runtime.
 *
 * Bounded on purpose. It reads the root plus one level of the workspace globs this repo
 * uses, never walks the tree, and never follows symlinks. A knowledge write must not be
 * able to turn into a filesystem crawl.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { PackageScripts } from "./script-resolution.js";

/** Directories under the root that may hold one level of packages. */
const PACKAGE_PARENTS = ["packages", "apps", "benchmarks"] as const;
const MAX_PACKAGES = 60;

function readOne(absDir: string, relDir: string): PackageScripts | null {
  const file = join(absDir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; scripts?: unknown };
    const scripts: Record<string, string> = {};
    if (parsed.scripts && typeof parsed.scripts === "object") {
      for (const [k, v] of Object.entries(parsed.scripts as Record<string, unknown>)) {
        if (typeof v === "string") scripts[k] = v;
      }
    }
    return { name: typeof parsed.name === "string" ? parsed.name : null, dir: relDir, scripts };
  } catch {
    // A malformed package.json yields no data, which resolves to `unresolved`. Never a
    // guess, and never a thrown error inside a knowledge write.
    return null;
  }
}

/** Read the workspace's package.json scripts. Returns `[]` when the root is unusable. */
export function collectWorkspaceScripts(workspaceRoot: string): PackageScripts[] {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return [];
  const out: PackageScripts[] = [];
  const root = readOne(workspaceRoot, "/");
  if (root) out.push(root);
  for (const parent of PACKAGE_PARENTS) {
    const parentAbs = join(workspaceRoot, parent);
    if (!existsSync(parentAbs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parentAbs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (out.length >= MAX_PACKAGES) return out;
      const pkg = readOne(join(parentAbs, name), `/${parent}/${name}`);
      if (pkg) out.push(pkg);
    }
    // A parent that is itself a package (benchmarks/package.json).
    if (out.length < MAX_PACKAGES) {
      const self = readOne(parentAbs, `/${parent}`);
      if (self && !out.some((p) => p.dir === self.dir)) out.push(self);
    }
  }
  return out;
}
