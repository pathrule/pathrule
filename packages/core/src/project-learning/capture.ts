// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isSafeSourcePath } from "../activity/activity-leads.js";
import { parseGitStatusPorcelainZ } from "../git/git-work-state.js";
import { readManifestFacts } from "./manifests.js";
import type { ProjectMapOptions, ProjectMapSnapshot, ProjectSource } from "@pathrule/protocol/project-learning-types.js";

const exec = promisify(execFile);
const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
  Math.max(
    min,
    Math.min(max, value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback),
  );
const MANIFESTS = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]);
const LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".swift": "swift",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".vue": "vue",
  ".svelte": "svelte",
  ".sql": "sql",
};
const EXCLUDED = new Set(["target", "artifacts", "out", "Pods", "Carthage", "venv", "__pycache__"]);
/** Per-file read cap. Claim verification uses the same bound, so a digest the map could
 *  not produce is never one a claim could be verified against. */
export const MAX_PROJECT_SOURCE_BYTES = 256 * 1024;

export const rootKey = (root: string): string => createHash("sha256").update(root).digest("hex");
export function allowedProjectPath(path: string): boolean {
  return (
    isSafeSourcePath(path) &&
    !path.split("/").some((part) => part.startsWith(".") || EXCLUDED.has(part))
  );
}
function kind(path: string): ProjectSource["kind"] | undefined {
  return MANIFESTS.has(basename(path))
    ? "manifest"
    : LANGUAGES[extname(path)]
      ? "source"
      : undefined;
}
interface InventoryFile {
  path: string;
  blob?: string;
}

/** Read-only Git commands, no hooks, remote access or optional index writes. */
async function git(root: string, args: string[], deadline: number): Promise<string | null> {
  if (Date.now() >= deadline) return null;
  try {
    const { stdout } = await exec(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: Math.max(1, Math.min(1500, deadline - Date.now())),
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    return stdout;
  } catch {
    return null;
  }
}

async function walk(
  root: string,
  max: number,
  deadline: number,
): Promise<{ files: InventoryFile[]; complete: boolean }> {
  const files: InventoryFile[] = [];
  let complete = true,
    visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (Date.now() >= deadline || depth > 24 || visited >= max * 4 || files.length >= max) {
      complete = false;
      return;
    }
    try {
      const dir = await opendir(resolve(root, directory));
      for await (const entry of dir) {
        if (Date.now() >= deadline || ++visited > max * 4 || files.length >= max) {
          complete = false;
          break;
        }
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (!allowedProjectPath(path) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && kind(path)) files.push({ path });
      }
    } catch {
      complete = false;
    }
  };
  await visit("", 0);
  return { files, complete };
}

/** Bytes, or the size that exceeded `maxBytes` (the file was not read), or nothing. */
export type ProjectSourceRead = { bytes: Buffer } | { tooLarge: number } | null;

/** Read a bounded regular file without following a symlink outside (or inside) the repo. */
export async function readProjectSourceDetailed(
  root: string,
  path: string,
  maxBytes: number,
): Promise<ProjectSourceRead> {
  if (!allowedProjectPath(path)) return null;
  const target = resolve(root, path);
  let handle;
  try {
    if ((await realpath(target)) !== target) return null;
    const before = await lstat(target);
    if (!before.isFile()) return null;
    if (before.size > maxBytes) return { tooLarge: before.size };
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino) return null;
    if (stat.size > maxBytes) return { tooLarge: stat.size };
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size)
      return null;
    return { bytes: buffer.subarray(0, bytesRead) };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export async function readProjectSource(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const read = await readProjectSourceDetailed(root, path, maxBytes);
  return read && "bytes" in read ? read.bytes : null;
}

export async function captureProjectMap(
  options: ProjectMapOptions,
  previous?: ProjectMapSnapshot,
): Promise<ProjectMapSnapshot> {
  const root = await realpath(options.localRootPath);
  const deadline = Date.now() + bounded(options.timeoutMs, 2500, 100, 10000);
  const max = bounded(options.maxFiles, 10000, 1, 20000);
  const readBudget = bounded(options.maxReadBytes, 8 * 1024 * 1024, 0, 32 * 1024 * 1024);
  const key = rootKey(root);
  const prior = previous?.version === 1 && previous.rootKey === key ? previous : undefined;
  const old = new Map(prior?.files.map((file) => [file.path, file]));
  const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"], deadline))?.trim();
  let head: string | null = null,
    status: string | null = null;
  let inventory: ProjectMapSnapshot["inventory"] = "filesystem";
  let entries: InventoryFile[] = [],
    complete = true;
  if (gitRoot) {
    const [revision, listed, worktree] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"], deadline),
      git(root, ["ls-files", "--stage", "-z", "--full-name", "--", "."], deadline),
      git(
        root,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--",
          ".",
        ],
        deadline,
      ),
    ]);
    if (listed !== null && worktree !== null) {
      inventory = "git";
      head = revision?.trim() || null;
      status = worktree;
      const prefix = relative(await realpath(gitRoot), root)
        .split(sep)
        .join("/");
      const localPath = (path: string): string | null =>
        !prefix ? path : path.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : null;
      const dirty = new Set(
        parseGitStatusPorcelainZ(worktree)
          .map((entry) => localPath(entry.relativePath))
          .filter(Boolean),
      );
      const paths = new Map<string, InventoryFile>();
      for (const record of listed.split("\0")) {
        const match = record.match(/^100(?:644|755) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/);
        if (!match) continue;
        const path = localPath(match[2]!);
        if (path && allowedProjectPath(path) && kind(path))
          paths.set(path, { path, blob: dirty.has(path) ? undefined : match[1] });
      }
      for (const entry of parseGitStatusPorcelainZ(worktree)) {
        const path = localPath(entry.relativePath);
        if (!path || !allowedProjectPath(path) || !kind(path)) continue;
        if (entry.gitStatus === "deleted") paths.delete(path);
        else if (entry.gitStatus === "untracked") paths.set(path, { path });
      }
      entries = [...paths.values()];
    }
  }
  if (inventory === "filesystem" && !gitRoot) {
    const walked = await walk(root, max, deadline);
    entries = walked.files;
    complete = walked.complete;
  } else if (inventory === "filesystem") {
    // An unanswered Git inventory is not permission to bypass its ignore rules.
    complete = false;
  }
  const listedFiles = entries.length;
  // Package boundaries are read before the potentially much larger source inventory.
  entries.sort(
    (a, b) =>
      Number(kind(b.path) === "manifest") - Number(kind(a.path) === "manifest") ||
      a.path.localeCompare(b.path),
  );
  if (entries.length > max) complete = false;
  const files: ProjectSource[] = [];
  let readBytes = 0,
    reusedManifests = 0;
  for (const entry of entries.slice(0, max)) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const file: ProjectSource = {
      path: entry.path,
      kind: kind(entry.path)!,
      language: LANGUAGES[extname(entry.path)] ?? "manifest",
      observation: "unavailable",
    };
    const cached = old.get(entry.path);
    if (entry.blob) {
      file.digest = `git:${entry.blob}`;
      file.observation = "indexed";
    }
    if (!file.digest || file.kind === "manifest") {
      const read = await readProjectSourceDetailed(
        root,
        entry.path,
        Math.min(MAX_PROJECT_SOURCE_BYTES, readBudget - readBytes),
      );
      const bytes = read && "bytes" in read ? read.bytes : null;
      if (bytes) readBytes += bytes.length;
      if (read && "tooLarge" in read && read.tooLarge > MAX_PROJECT_SOURCE_BYTES) {
        // Over the per-file cap, not merely over what is left of the read budget. Every
        // later scan would hit the same wall, so treating it as unavailable meant a repo
        // with one large generated or translation file never saved a map and rescanned
        // from zero on every turn. Recorded as known-but-unhashed instead: the path is
        // listed without a sha256 digest, so nothing can cite it as read evidence. A clean
        // manifest keeps its Git blob identity; it just has no parsed facts.
        file.observation = "oversized";
      } else if (bytes && !bytes.includes(0)) {
        // A manifest's facts always cite the bytes actually parsed, even on a dirty tree.
        // For clean Git files keep its Git blob identity so reuse is O(1) on later scans.
        if (entry.blob) {
          const algorithm = entry.blob.length === 64 ? "sha256" : "sha1";
          const blob = createHash(algorithm)
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
          if (blob !== entry.blob) file.digest = undefined;
        }
        file.digest ??= `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        file.observation = "read";
        if (file.kind === "manifest") {
          if (cached?.digest === file.digest && cached.facts) {
            file.facts = cached.facts;
            reusedManifests++;
          } else file.facts = readManifestFacts(file.path, bytes.toString("utf8"));
          if (!file.facts) file.observation = "unavailable";
        }
      } else {
        file.digest = undefined;
        file.observation = "unavailable";
      }
    }
    files.push(file);
  }
  let consistency: ProjectMapSnapshot["consistency"] = "stable";
  if (inventory === "git") {
    const [nextHead, nextStatus] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"], deadline),
      git(
        root,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=all",
          "--",
          ".",
        ],
        deadline,
      ),
    ]);
    if ((nextHead?.trim() || null) !== head || nextStatus === null || nextStatus !== status)
      consistency = "changed_during_scan";
  }
  const paths = new Set(files.map((file) => file.path));
  return {
    version: 1,
    rootKey: key,
    observedAt: new Date().toISOString(),
    head,
    phase: prior ? "incremental" : "initial",
    inventory,
    consistency,
    files,
    coverage: {
      inventoryComplete: complete,
      listedFiles,
      capturedFiles: files.length,
      unavailableFiles: files.filter((file) => file.observation === "unavailable").length,
      oversizedFiles: files.filter((file) => file.observation === "oversized").length,
      reusedManifests,
      readBytes,
    },
    changes: {
      added: files.filter((file) => !old.has(file.path)).length,
      changed: files.filter(
        (file) => old.has(file.path) && old.get(file.path)?.digest !== file.digest,
      ).length,
      removed:
        complete && consistency === "stable"
          ? [...old.keys()].filter((path) => !paths.has(path)).length
          : null,
    },
  };
}
