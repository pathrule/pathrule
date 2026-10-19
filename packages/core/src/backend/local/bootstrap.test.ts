// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { SCHEMA_VERSION } from "./schema.js";
import { resolveLocalPrincipal } from "./identity.js";

/** Open a DB the way LocalBackend itself does, for the white-box `user_version` probes below. */
function openRaw(path: string): Database.Database {
  return new Database(path);
}

// The canonical-store bootstrap + numbered-migration runner.
describe("LocalBackend bootstrap", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmps.length = 0;
  });

  it(":memory: applies the schema (CRUD works without an explicit migrate call)", async () => {
    const b = new LocalBackend(":memory:");
    const node = await b.ensureNodeForPath("ws", "/api");
    const mem = await b.writeMemory({
      workspaceId: "ws",
      nodeId: node.id,
      title: "t",
      content: "c",
    });
    expect((await b.readMemory(mem.id))?.title).toBe("t");
    b.close();
  });

  it("openForWorkspace creates ~/.pathrule/<ws>/pathrule.db, stamps user_version, persists, 0600", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-home-"));
    tmps.push(home);
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const b1 = LocalBackend.openForWorkspace("ws-x", env);
    const node = await b1.ensureNodeForPath("ws-x", "/api");
    const mem = await b1.writeMemory({
      workspaceId: "ws-x",
      nodeId: node.id,
      title: "persisted",
      content: "body",
    });
    b1.close();

    const dbPath = join(home, "ws-x", "pathrule.db");
    expect(existsSync(dbPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600); // file tightened to owner-only
    }

    // White-box: user_version reflects the latest applied migration.
    const raw = openRaw(dbPath);
    expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    raw.close();

    // Re-open: migrations are a no-op and the prior write survives.
    const b2 = LocalBackend.openForWorkspace("ws-x", env);
    expect((await b2.readMemory(mem.id))?.title).toBe("persisted");
    b2.close();
  });

  it("stamps the local principal on created_by/last_edited_by identity", async () => {
    const b = new LocalBackend(":memory:", { principal: "alice" });
    const node = await b.ensureNodeForPath("ws", "/x");
    const mem = await b.writeMemory({
      workspaceId: "ws",
      nodeId: node.id,
      title: "t",
      content: "c",
    });
    expect(mem.createdBy).toBe("alice");
    expect(mem.lastEditedBy).toBe("alice");
    const updated = await b.updateMemory({ id: mem.id, content: "c2" });
    expect(updated.lastEditedBy).toBe("alice");
    b.close();
  });

  it("resolveLocalPrincipal honors PATHRULE_LOCAL_PRINCIPAL, else falls back to a non-empty name", () => {
    expect(
      resolveLocalPrincipal({ PATHRULE_LOCAL_PRINCIPAL: "  carol  " } as NodeJS.ProcessEnv),
    ).toBe("carol");
    // No override → OS username (or the "local" fallback); always a non-empty string.
    expect(resolveLocalPrincipal({} as NodeJS.ProcessEnv).length).toBeGreaterThan(0);
  });

  it("migration runner is idempotent — re-running over an at-version DB changes nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-home-"));
    tmps.push(home);
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    LocalBackend.openForWorkspace("ws-y", env).close();
    // Second open re-runs runMigrations(); must not throw or downgrade user_version.
    const b = LocalBackend.openForWorkspace("ws-y", env);
    b.close();
    const raw = openRaw(join(home, "ws-y", "pathrule.db"));
    expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    raw.close();
  });

  // discoverWorkspaceForCwd is the OSS CLI entry primitive: pick the
  // local store serving a cwd across the ~/.pathrule/<id> stores.
  it("discoverWorkspaceForCwd longest-prefix-matches across local stores; null when none cover", () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-home-"));
    tmps.push(home);
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    // Two registered local workspaces: a monorepo root and a nested package.
    const root = LocalBackend.openForWorkspace("ws-root", env);
    root.registerWorkspace({ workspaceId: "ws-root", localRootPath: "/repo" });
    root.close();
    const nested = LocalBackend.openForWorkspace("ws-nested", env);
    nested.registerWorkspace({ workspaceId: "ws-nested", localRootPath: "/repo/packages/api" });
    nested.close();
    // A store with no registered root must be skipped, not throw.
    LocalBackend.openForWorkspace("ws-unregistered", env).close();

    expect(LocalBackend.discoverWorkspaceForCwd("/repo/src", env)).toEqual({
      workspaceId: "ws-root",
      localRootPath: "/repo",
      relativePath: "/src",
    });
    expect(LocalBackend.discoverWorkspaceForCwd("/repo/packages/api/handlers", env)).toEqual({
      workspaceId: "ws-nested",
      localRootPath: "/repo/packages/api",
      relativePath: "/handlers",
    });
    expect(LocalBackend.discoverWorkspaceForCwd("/repo/packages/api", env)?.relativePath).toBe("");
    expect(LocalBackend.discoverWorkspaceForCwd("/elsewhere", env)).toBeNull();
  });

  it("discoverWorkspaceForCwd returns null when ~/.pathrule does not exist", () => {
    const env = { PATHRULE_HOME: join(tmpdir(), "pathrule-absent-xyz") } as NodeJS.ProcessEnv;
    expect(LocalBackend.discoverWorkspaceForCwd("/anywhere", env)).toBeNull();
  });
});
