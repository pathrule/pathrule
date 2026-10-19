// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type WorkStateGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unknown";

export function isWorkStateGitStatus(value: unknown): value is WorkStateGitStatus {
  return (
    value === "modified" ||
    value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "untracked" ||
    value === "unknown"
  );
}

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 2_000;

export interface GitWorkStateEntry {
  relativePath: string;
  gitStatus: WorkStateGitStatus;
}

export interface GitWorkStateResult {
  entries: GitWorkStateEntry[];
  degraded: boolean;
}

export function normalizeWorkspaceRelativePath(path: string): string | null {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return null;
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith(".git/") ||
    /[\x00-\x1F]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function toWorkspaceRelativePath(workspaceRoot: string, targetPath: string): string | null {
  const rel = relative(resolve(workspaceRoot), resolve(targetPath)).split(sep).join("/");
  return normalizeWorkspaceRelativePath(rel);
}

export function parseGitStatusPorcelainZ(output: string | Buffer): GitWorkStateEntry[] {
  const raw = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const entries: GitWorkStateEntry[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const statusPair = record.slice(0, 2);
    const pathPart = record.slice(3);
    const status = statusFromPair(statusPair);

    if (statusPair.includes("R") || statusPair.includes("C")) {
      const target = normalizeWorkspaceRelativePath(pathPart);
      if (target) entries.push({ relativePath: target, gitStatus: "renamed" });
      const source = normalizeWorkspaceRelativePath(parts[i + 1] ?? "");
      if (source) entries.push({ relativePath: source, gitStatus: "renamed" });
      i += 1;
      continue;
    }

    const relativePath = normalizeWorkspaceRelativePath(pathPart);
    if (relativePath) entries.push({ relativePath, gitStatus: status });
  }

  return dedupeEntries(entries);
}

/**
 * The workspace's uncommitted files, relative to the WORKSPACE root, which is how the
 * hook and the file watcher name them.
 *
 * Porcelain paths are relative to the repository root, never to the working directory.
 * For a workspace that is a subfolder of its repository the scan used to publish
 * `packages/app/src/x.ts` while every consumer asked about `src/x.ts`, so no dirty row
 * ever matched, and every change elsewhere in the repository was published as well.
 *
 * A wholly untracked directory stays one `dir/` entry, as git reports it: listing its
 * files could publish thousands of rows for one unignored folder. Consumers match a
 * path against the directory rows above it (see `workStateRowsForPath`).
 */
export async function scanGitWorkState(
  workspaceRoot: string,
  options: { timeoutMs?: number } = {},
): Promise<GitWorkStateResult> {
  const timeout = options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;
  try {
    const { stdout: prefixOut } = await execFileAsync("git", ["rev-parse", "--show-prefix"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout,
    });
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--", "."], {
      cwd: workspaceRoot,
      encoding: "buffer",
      maxBuffer: 5 * 1024 * 1024,
      timeout,
    });
    return {
      entries: scopeToWorkspace(parseGitStatusPorcelainZ(stdout), prefixOut.replace(/\n$/, "")),
      degraded: false,
    };
  } catch {
    return { entries: [], degraded: true };
  }
}

/** Re-roots repository-relative entries at the workspace and drops the ones outside it. */
export function scopeToWorkspace(
  entries: GitWorkStateEntry[],
  repositoryPrefix: string,
): GitWorkStateEntry[] {
  if (repositoryPrefix === "") return entries;
  const prefix = repositoryPrefix.endsWith("/") ? repositoryPrefix : `${repositoryPrefix}/`;
  return entries.flatMap((entry) => {
    if (!entry.relativePath.startsWith(prefix)) return [];
    const relativePath = normalizeWorkspaceRelativePath(entry.relativePath.slice(prefix.length));
    return relativePath ? [{ ...entry, relativePath }] : [];
  });
}

function statusFromPair(pair: string): WorkStateGitStatus {
  if (pair === "??") return "untracked";
  if (pair.includes("A")) return "added";
  if (pair.includes("D")) return "deleted";
  if (pair.includes("R") || pair.includes("C")) return "renamed";
  if (pair.includes("M") || pair.includes("T") || pair.includes("U")) return "modified";
  return "unknown";
}

function dedupeEntries(entries: GitWorkStateEntry[]): GitWorkStateEntry[] {
  const byPath = new Map<string, GitWorkStateEntry>();
  for (const entry of entries) byPath.set(entry.relativePath, entry);
  return Array.from(byPath.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
