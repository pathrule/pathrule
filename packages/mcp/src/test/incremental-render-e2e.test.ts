// SPDX-License-Identifier: Apache-2.0
// End-to-end incremental re-render on a REAL LocalBackend (SQLite)
// and a REAL temp filesystem. Proves the GATE claim with genuine compiled data:
// editing one memory rewrites only that directory's compiled file and leaves
// every other directory's file byte-for-byte untouched, removing nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalBackend, resolveLocalPrincipal } from "@pathrule/core";
import { gatherLocalMultiClientInput, renderForClients } from "@pathrule/integrations/client-renderers/orchestrator.js";
import { scopeToEntity } from "@pathrule/integrations/client-renderers/pipeline.js";
import { writeMultiClientFiles } from "@pathrule/integrations/client-renderers/disk-writer.js";
import { __resetHookCommandForTests, setHookCommand } from "@pathrule/integrations/hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

// This test asserts that a memory BODY edit re-renders the affected dir's
// COMPILED FILE — a full-body contract. claude-code now renders the SLIM router
// (title index, bodies via the hook), so a body edit legitimately leaves its
// file unchanged. codex is the canonical full-body client, so the incremental
// compiled-file re-render scoping is asserted there.
const TARGETS = ["codex"] as const;
const DIR_FILE = "AGENTS.md";

describe("incremental re-render e2e (LocalBackend, real fs)", () => {
  const tmps: string[] = [];
  afterAll(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
  });
  function freshDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  }

  it("editing one memory rewrites only that dir's file; other dirs untouched", async () => {
    const home = freshDir("pr-e2e-home-");
    const root = freshDir("pr-e2e-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    const wid = "ws-e2e-incremental";

    const backend = LocalBackend.openForWorkspace(wid, env);
    let libMemId = "";
    try {
      backend.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: root });
      const lib = await backend.ensureNodeForPath(wid, "/lib");
      const api = await backend.ensureNodeForPath(wid, "/api");
      const libMem = await backend.writeMemory({
        workspaceId: wid,
        nodeId: lib.id,
        title: "Encapsulation",
        content: "Plugins create a new context.",
      });
      libMemId = libMem.id;
      await backend.writeMemory({
        workspaceId: wid,
        nodeId: api.id,
        title: "Auth",
        content: "Verify the JWT on every request.",
      });

      const name = backend.getWorkspaceName(wid) ?? wid;
      const userId = resolveLocalPrincipal(env);

      // 1) Baseline FULL render — both dir files land on disk.
      const full = await gatherLocalMultiClientInput({ backend, workspaceId: wid, workspaceName: name, userId });
      await writeMultiClientFiles({
        workspaceRoot: root,
        results: renderForClients(full, [...TARGETS]),
        sweepFor: [...TARGETS],
      });
      const libPath = join(root, "lib", DIR_FILE);
      const apiPath = join(root, "api", DIR_FILE);
      expect(existsSync(libPath)).toBe(true);
      expect(existsSync(apiPath)).toBe(true);
      const apiBefore = readFileSync(apiPath, "utf8");
      const libBefore = readFileSync(libPath, "utf8");

      // 2) Edit the /lib memory, then INCREMENTAL re-render scoped to it.
      await backend.updateMemory({
        id: libMemId,
        content: "Plugins create a new isolated context with its own decorators.",
      });
      const after = await gatherLocalMultiClientInput({ backend, workspaceId: wid, workspaceName: name, userId });
      const scoped = scopeToEntity(after, { kind: "memory", id: libMemId });
      expect(scoped.sweep).toBe(false); // incremental
      const disk = await writeMultiClientFiles({
        workspaceRoot: root,
        results: renderForClients(scoped.input, [...TARGETS]),
        sweepFor: [...TARGETS],
        sweep: scoped.sweep,
      });

      // 3) Assertions: only lib changed; api byte-identical; nothing removed.
      const libAfter = readFileSync(libPath, "utf8");
      const apiAfter = readFileSync(apiPath, "utf8");
      expect(libAfter).not.toBe(libBefore); // reflects the edit
      expect(libAfter).toContain("isolated context with its own decorators");
      expect(apiAfter).toBe(apiBefore); // UNTOUCHED
      expect(disk.removed).toBe(0); // sweep disabled — nothing deleted
      expect(disk.written).toBe(1); // only lib/CLAUDE.md rewritten
    } finally {
      backend.close();
    }
  });

  it("a non-matching entity falls back to a full sweeping render", async () => {
    const home = freshDir("pr-e2e-home-");
    const root = freshDir("pr-e2e-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    const wid = "ws-e2e-fallback";
    const backend = LocalBackend.openForWorkspace(wid, env);
    try {
      backend.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: root });
      const lib = await backend.ensureNodeForPath(wid, "/lib");
      await backend.writeMemory({ workspaceId: wid, nodeId: lib.id, title: "X", content: "y" });
      const name = backend.getWorkspaceName(wid) ?? wid;
      const input = await gatherLocalMultiClientInput({
        backend,
        workspaceId: wid,
        workspaceName: name,
        userId: resolveLocalPrincipal(env),
      });
      const scoped = scopeToEntity(input, { kind: "memory", id: "ghost-id" });
      expect(scoped.sweep).toBe(true);
      expect(scoped.input.knowledge?.length).toBe(input.knowledge?.length);
    } finally {
      backend.close();
    }
  });
});
