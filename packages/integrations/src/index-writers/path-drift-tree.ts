// SPDX-License-Identifier: Apache-2.0
// The checkout as path-drift detection reads it (core/knowledge-map/path-drift.ts): the files git lists,
// tracked and untracked with ignores applied and deletions left out, a size-capped text reader, and the
// renames git recorded. Outside a git checkout there is no list, and so no drift: a walk of an arbitrary
// directory could cross into dependencies and build output, which name every file twice.
//
// The rename history is read only when a memory names a file that is gone, and cached per HEAD next to
// the index, so a sync of an unchanged checkout pays nothing for it (0.8 s for 3,800 commits here).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DriftTree } from "@pathrule/core/knowledge-map/path-drift.js";

const MAX_FILES = 50_000;
const MAX_READ_BYTES = 256 * 1024;
const RENAME_CACHE_FILE = "rename-map.json";
const RENAME_HOPS = 8;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 20_000,
  });
}

const gitFiles = (root: string, args: string[]): string[] =>
  git(root, ["ls-files", ...args])
    .split("\n")
    .filter(Boolean);

/** Old path -> newest new path for every rename git recorded, relative to `root` (which may sit below the repository's top). */
function renameMap(root: string, cacheDir: string | undefined): Map<string, string> {
  let head: string, prefix: string;
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
    prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return new Map();
  }
  const cacheFile = cacheDir ? join(cacheDir, RENAME_CACHE_FILE) : null;
  if (cacheFile) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        head?: string;
        prefix?: string;
        renames?: Record<string, string>;
      };
      if (cached.head === head && cached.prefix === prefix && cached.renames)
        return new Map(Object.entries(cached.renames));
    } catch {
      /* no cache yet */
    }
  }
  const out = new Map<string, string>();
  try {
    for (const line of git(root, [
      "log",
      "-M",
      "--diff-filter=R",
      "--name-status",
      "--format=",
    ]).split("\n")) {
      const [status, from, to] = line.split("\t");
      if (!status?.startsWith("R") || !from?.startsWith(prefix) || !to?.startsWith(prefix))
        continue;
      const old = from.slice(prefix.length);
      if (!out.has(old)) out.set(old, to.slice(prefix.length));
    }
  } catch {
    return out;
  }
  if (cacheFile && cacheDir) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ head, prefix, renames: Object.fromEntries(out) }));
    } catch {
      /* the next sync reads the history again */
    }
  }
  return out;
}

export function readDriftTree(root: string, cacheDir?: string): DriftTree | null {
  let files: string[];
  try {
    const deleted = new Set(gitFiles(root, ["-d"]));
    files = gitFiles(root, ["-co", "--exclude-standard"]).filter((f) => !deleted.has(f));
  } catch {
    return null;
  }
  if (files.length > MAX_FILES) return null;
  const present = new Set(files);
  let renames: Map<string, string> | null = null;
  return {
    files,
    read(path) {
      try {
        const abs = join(root, path);
        return statSync(abs).size > MAX_READ_BYTES ? null : readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    renamedTo(path) {
      renames ??= renameMap(root, cacheDir);
      let at = path;
      for (let hop = 0; hop < RENAME_HOPS; hop++) {
        const next = renames.get(at);
        if (!next || next === path) break;
        at = next;
        if (present.has(at)) return at;
      }
      return null;
    },
  };
}
