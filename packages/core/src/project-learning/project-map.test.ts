// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureProjectMap } from "./capture.js";
import { refreshProjectMap } from "./index.js";
import { projectMapPath } from "./store.js";
import { readManifestFacts } from "./manifests.js";
import { projectMapContext } from "./context.js";
import type { ProjectMapSnapshot } from "@pathrule/protocol/project-learning-types.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pathrule-map-")));
  roots.push(root);
  return root;
}
async function put(root: string, path: string, body: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}
async function git(root: string, ...args: string[]) {
  return exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root },
  );
}
async function fixture(useGit = true) {
  const root = await directory(),
    home = await directory();
  await put(root, "package.json", '{"name":"sample","scripts":{"test":"TOKEN=hidden npm test"}}');
  await put(
    root,
    "packages/api/package.json",
    '{"name":"@sample/api","dependencies":{"@sample/core":"workspace:*"}}',
  );
  await put(root, "packages/core/package.json", '{"name":"@sample/core"}');
  await put(root, "packages/api/src/server.ts", 'export const server = "raw-source-not-to-store";');
  await put(root, "packages/core/src/store.ts", "export const store = 1;");
  if (useGit) {
    await git(root, "init");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "fixture");
  }
  return { workspaceId: "test-map", localRootPath: root, env: { PATHRULE_HOME: home } };
}

describe("source-backed project map", () => {
  it("charges rejected binary content to the read budget", async () => {
    const root = await directory();
    await put(root, "a.ts", "\0".repeat(16));
    await put(root, "b.ts", "a = 1;");
    const snapshot = await captureProjectMap({
      workspaceId: "budget",
      localRootPath: root,
      maxReadBytes: 16,
    });
    expect(snapshot.coverage.readBytes).toBe(16);
    expect(snapshot.files.every((file) => file.observation === "unavailable")).toBe(true);
  });

  it("captures a cold repository without a model, writes only internal metadata and scopes the module graph", async () => {
    const options = await fixture();
    const before = (await git(options.localRootPath, "status", "--porcelain")).stdout;
    const result = await refreshProjectMap({ ...options, scope: "/packages/api/src" });
    expect(result).toMatchObject({ status: "current", phase: "initial", persisted: true });
    expect(result.modules[0]).toMatchObject({
      name: "@sample/api",
      path: "/packages/api",
      dependencies: [{ name: "@sample/core", kind: "runtime", sameNameModule: "/packages/core" }],
      evidence: { path: "packages/api/package.json", digest: expect.stringMatching(/^git:/) },
    });
    expect(result.sourceExamples).toEqual(["packages/api/src/server.ts"]);
    expect((await git(options.localRootPath, "status", "--porcelain")).stdout).toBe(before);
    const path = (await projectMapPath(options.workspaceId, options.localRootPath, options.env))!;
    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain("raw-source-not-to-store");
    expect(stored).not.toContain("TOKEN=hidden");
    expect(stored).not.toContain(options.localRootPath);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = await refreshProjectMap(options);
    expect(second).toMatchObject({
      phase: "incremental",
      changes: { added: 0, changed: 0, removed: 0 },
    });
    expect(second.coverage?.reusedManifests).toBe(3);
    expect(second.reviewTargets?.length).toBeGreaterThan(0);
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    expect(checkpoint.reviewTargets).toHaveLength(5);
  });

  it("refreshes dirty manifests and removes deleted paths even when HEAD has not changed", async () => {
    const options = await fixture();
    const first = await refreshProjectMap(options);
    await put(options.localRootPath, "packages/api/package.json", '{"name":"@sample/new-api"}');
    await rm(join(options.localRootPath, "packages/api/src/server.ts"));
    await put(
      options.localRootPath,
      "packages/api/src/replacement.ts",
      "export const replacement = 2;",
    );
    const second = await refreshProjectMap({ ...options, scope: "/packages/api" });
    expect(second.head).toBe(first.head);
    expect(second.modules[0]?.name).toBe("@sample/new-api");
    expect(second.modules[0]?.evidence.digest).toMatch(/^sha256:/);
    expect(second.sourceExamples).toEqual(["packages/api/src/replacement.ts"]);
    expect(second.changes).toEqual({ added: 1, changed: 1, removed: 1 });
    const quiet = await refreshProjectMap({ ...options, scope: "/packages/api" });
    expect(quiet.changes).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(quiet.reviewTargets).toEqual(second.reviewTargets);
  });

  it("saves the map when a changed file is over the per-file cap, instead of rescanning forever", async () => {
    const options = await fixture();
    await refreshProjectMap(options);
    // A dirty translation table bigger than the per-file read cap, the shape that kept a
    // real repository from ever persisting its map.
    const big = `export const en = {\n${"  key: 'value',\n".repeat(20_000)}};\n`;
    await put(options.localRootPath, "packages/api/src/i18n-en.ts", big);
    await put(options.localRootPath, "packages/api/src/server.ts", "export const server = 2;");
    const path = (await projectMapPath(options.workspaceId, options.localRootPath, options.env))!;

    const result = await refreshProjectMap(options);
    expect(result).toMatchObject({ status: "current", persisted: true });
    expect(result.coverage).toMatchObject({ unavailableFiles: 0, oversizedFiles: 1 });
    // Charged nothing: it was never read.
    expect(result.coverage?.readBytes).toBeLessThan(big.length);
    // Present in the checkpoint only because this scan was saved.
    const stored = JSON.parse(await readFile(path, "utf8")) as ProjectMapSnapshot;
    const entry = stored.files.find((file) => file.path === "packages/api/src/i18n-en.ts");
    expect(entry).toMatchObject({ observation: "oversized" });
    expect(entry?.digest).toBeUndefined();
    // The small change next to it is still hashed and still becomes a review lead.
    expect(stored.files.find((file) => file.path === "packages/api/src/server.ts")?.digest).toMatch(
      /^sha256:/,
    );
    expect(stored.reviewTargets?.some((t) => t.path === "packages/api/src/server.ts")).toBe(true);
  });

  it("does not trust assume-unchanged on a manifest as proof of its current contents", async () => {
    const options = await fixture();
    await refreshProjectMap(options);
    await git(
      options.localRootPath,
      "update-index",
      "--assume-unchanged",
      "packages/api/package.json",
    );
    await put(
      options.localRootPath,
      "packages/api/package.json",
      '{"name":"@sample/actual-bytes"}',
    );
    const next = await refreshProjectMap({ ...options, scope: "/packages/api" });
    expect(next.modules[0]?.name).toBe("@sample/actual-bytes");
    expect(next.modules[0]?.evidence.digest).toMatch(/^sha256:/);
  });

  it("has a filesystem fallback, with independent checkpoints for different roots", async () => {
    const options = await fixture(false);
    const first = await refreshProjectMap(options);
    expect(first).toMatchObject({ status: "current", head: null, phase: "initial" });
    expect(first.modules[0]?.evidence.digest).toMatch(/^sha256:/);
    const other = await directory();
    await put(other, "package.json", '{"name":"other-project"}');
    const second = await refreshProjectMap({ ...options, localRootPath: other });
    expect(second.phase).toBe("initial");
    expect(second.modules.map((module) => module.name)).toEqual(["other-project"]);
  });

  it("ignores Git-excluded files, secret paths, generated trees and symlinks", async () => {
    const options = await fixture();
    const outside = await directory();
    await put(outside, "package.json", '{"name":"must-not-appear"}');
    await put(options.localRootPath, ".gitignore", "ignored/\n");
    await put(options.localRootPath, "ignored/package.json", '{"name":"must-not-appear"}');
    await put(options.localRootPath, ".env.local", "SECRET=must-not-appear");
    await put(options.localRootPath, "dist/package.json", '{"name":"must-not-appear"}');
    await symlink(join(outside, "package.json"), join(options.localRootPath, "linked.ts"));
    await git(options.localRootPath, "add", ".");
    const snapshot = await captureProjectMap(options);
    expect(snapshot.files.some((file) => /ignored|\.env|dist|linked/.test(file.path))).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("must-not-appear");
  });

  it("refuses a storage location in the repository, including a symlinked home", async () => {
    const options = await fixture(false);
    const before = await readdir(options.localRootPath);
    const result = await refreshProjectMap({
      ...options,
      env: { PATHRULE_HOME: join(options.localRootPath, "..internal") },
    });
    expect(result.persisted).toBe(false);
    expect(await readdir(options.localRootPath)).toEqual(before);
    const alias = join(options.env.PATHRULE_HOME, "alias");
    await symlink(options.localRootPath, alias);
    expect((await refreshProjectMap({ ...options, env: { PATHRULE_HOME: alias } })).persisted).toBe(
      false,
    );
    expect(await readdir(options.localRootPath)).toEqual(before);
  });

  it("reports truncation and does not overwrite a complete checkpoint with a partial capture", async () => {
    const options = await fixture();
    await refreshProjectMap(options);
    const path = (await projectMapPath(options.workspaceId, options.localRootPath, options.env))!;
    const before = await readFile(path, "utf8");
    const limited = await refreshProjectMap({ ...options, maxFiles: 1 });
    expect(limited).toMatchObject({
      status: "partial",
      persisted: false,
      coverage: { inventoryComplete: false },
      changes: { removed: null },
    });
    expect(await readFile(path, "utf8")).toBe(before);
    const byteLimited = await refreshProjectMap({ ...options, maxReadBytes: 0 });
    expect(byteLimited.status).toBe("partial");
    expect(byteLimited.modules).toEqual([]);
  });

  it("keeps nested workspace paths relative to that workspace", async () => {
    const options = await fixture();
    const map = await refreshProjectMap({
      ...options,
      localRootPath: join(options.localRootPath, "packages/api"),
    });
    expect(map.sourceExamples).toEqual(["src/server.ts"]);
    expect(map.modules[0]).toMatchObject({
      path: "/",
      name: "@sample/api",
      evidence: { path: "package.json" },
    });
  });

  it("drops stale declarations when a previously valid manifest becomes invalid", async () => {
    const options = await fixture();
    await refreshProjectMap(options);
    await put(options.localRootPath, "packages/api/package.json", "{broken");
    const next = await refreshProjectMap({ ...options, scope: "/packages/api" });
    expect(next.status).toBe("partial");
    expect(next.modules.some((module) => module.name === "@sample/api")).toBe(false);
  });
});

describe("manifest facts", () => {
  it("bounds agent context without cutting a path or inventing a uniquely resolved dependency", () => {
    const files: ProjectMapSnapshot["files"] = Array.from({ length: 20 }, (_, i) => ({
      path: `packages/${"long-".repeat(60)}${i}/package.json`,
      language: "manifest",
      kind: "manifest",
      digest: `sha256:${"a".repeat(64)}`,
      observation: "read",
      facts: {
        ecosystem: "node",
        name: "duplicate",
        taskNames: [],
        dependencies: Array.from({ length: 12 }, () => ({ name: "duplicate", kind: "runtime" })),
      },
    }));
    const snapshot: ProjectMapSnapshot = {
      version: 1,
      rootKey: "test",
      observedAt: new Date().toISOString(),
      head: null,
      phase: "initial",
      inventory: "filesystem",
      consistency: "stable",
      files,
      coverage: {
        inventoryComplete: true,
        listedFiles: 20,
        capturedFiles: 20,
        unavailableFiles: 0,
        reusedManifests: 0,
        readBytes: 1,
      },
      changes: { added: 20, changed: 0, removed: 0 },
    };
    const context = projectMapContext(snapshot);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(6000);
    for (const module of context.modules) {
      expect(files.some((file) => file.path === module.evidence.path)).toBe(true);
      expect(module.dependencies.every((dep) => dep.sameNameModule === undefined)).toBe(true);
    }
    expect(context.omittedModules).toBeGreaterThan(0);
  });

  it("supports Rust, Python and Go declarations without storing remote URLs or script bodies", () => {
    expect(
      readManifestFacts("Cargo.toml", '[package]\nname="crate"\n[dependencies]\nserde="1"\n'),
    ).toMatchObject({
      ecosystem: "rust",
      name: "crate",
      dependencies: [{ name: "serde", kind: "runtime" }],
    });
    expect(
      readManifestFacts(
        "pyproject.toml",
        '[project]\nname="service"\ndependencies=["requests>=2", "private @ https://token@example.com/pkg"]\n',
      ),
    ).toMatchObject({
      ecosystem: "python",
      dependencies: [
        { name: "requests", kind: "runtime" },
        { name: "private", kind: "runtime" },
      ],
    });
    expect(
      readManifestFacts(
        "go.mod",
        "module example.com/service\nrequire (\nexample.com/lib v1.0.0\n)\n",
      ),
    ).toMatchObject({
      ecosystem: "go",
      name: "example.com/service",
      dependencies: [{ name: "example.com/lib", kind: "runtime" }],
    });
    expect(
      JSON.stringify(
        readManifestFacts(
          "package.json",
          '{"name":"project","scripts":{"test":"curl https://secret"},"dependencies":{"lib":"https://token@example.com"}}',
        ),
      ),
    ).not.toContain("https");
  });
});
