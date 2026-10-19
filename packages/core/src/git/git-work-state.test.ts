// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeWorkspaceRelativePath,
  parseGitStatusPorcelainZ,
  scanGitWorkState,
  scopeToWorkspace,
} from "./git-work-state.js";

describe("git work-state parser", () => {
  it("parses porcelain z status into collision paths", () => {
    const output = [
      " M src/app.ts",
      "?? src/new.ts",
      "D  src/deleted.ts",
      "R  src/renamed.ts",
      "src/old.ts",
      "",
    ].join("\0");

    expect(parseGitStatusPorcelainZ(output)).toEqual([
      { relativePath: "src/app.ts", gitStatus: "modified" },
      { relativePath: "src/deleted.ts", gitStatus: "deleted" },
      { relativePath: "src/new.ts", gitStatus: "untracked" },
      { relativePath: "src/old.ts", gitStatus: "renamed" },
      { relativePath: "src/renamed.ts", gitStatus: "renamed" },
    ]);
  });

  it("rejects absolute, parent, control, and git-internal paths", () => {
    expect(normalizeWorkspaceRelativePath("/tmp/x")).toBeNull();
    expect(normalizeWorkspaceRelativePath("../x")).toBeNull();
    expect(normalizeWorkspaceRelativePath("src/../x")).toBeNull();
    expect(normalizeWorkspaceRelativePath(".git/config")).toBeNull();
    expect(normalizeWorkspaceRelativePath("src/\u0000x")).toBeNull();
  });
});

describe("git work-state scan", () => {
  const repos: string[] = [];
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A repository with one committed file per package, then changes in both. */
  async function monorepo() {
    const repo = await mkdtemp(join(tmpdir(), "pathrule-git-work-state-"));
    repos.push(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
    git("init", "-q");
    await mkdir(join(repo, "packages/app/src"), { recursive: true });
    await mkdir(join(repo, "packages/api"), { recursive: true });
    await writeFile(join(repo, "packages/app/src/tracked.ts"), "a\n");
    await writeFile(join(repo, "packages/api/server.ts"), "b\n");
    git("add", ".");
    git("commit", "-qm", "init");
    await writeFile(join(repo, "packages/app/src/tracked.ts"), "changed\n");
    await writeFile(join(repo, "packages/api/server.ts"), "changed\n");
    await mkdir(join(repo, "packages/app/src/feature"), { recursive: true });
    await writeFile(join(repo, "packages/app/src/feature/a.ts"), "new\n");
    await writeFile(join(repo, "packages/app/src/feature/b.ts"), "new\n");
    return repo;
  }

  it("names files relative to a workspace that is a subfolder of its repository", async () => {
    const repo = await monorepo();

    const result = await scanGitWorkState(join(repo, "packages/app"));

    expect(result.degraded).toBe(false);
    // The hook and the file watcher call it src/tracked.ts; packages/api is another
    // workspace's business and stays out.
    expect(result.entries).toEqual([
      { relativePath: "src/feature/", gitStatus: "untracked" },
      { relativePath: "src/tracked.ts", gitStatus: "modified" },
    ]);
  });

  it("keeps repository-relative names when the workspace is the repository root", async () => {
    const repo = await monorepo();

    const result = await scanGitWorkState(repo);

    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "packages/api/server.ts",
      "packages/app/src/feature/",
      "packages/app/src/tracked.ts",
    ]);
  });

  it("reports a folder that is not a repository as degraded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pathrule-git-work-state-none-"));
    repos.push(dir);

    await expect(scanGitWorkState(dir)).resolves.toEqual({ entries: [], degraded: true });
  });

  it("re-roots entries at the workspace and drops the rest", () => {
    expect(
      scopeToWorkspace(
        [
          { relativePath: "packages/app/src/a.ts", gitStatus: "modified" },
          { relativePath: "packages/application/x.ts", gitStatus: "modified" },
          { relativePath: "packages/app/", gitStatus: "untracked" },
          { relativePath: "README.md", gitStatus: "modified" },
        ],
        "packages/app/",
      ),
    ).toEqual([{ relativePath: "src/a.ts", gitStatus: "modified" }]);
  });
});
