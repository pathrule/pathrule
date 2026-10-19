// SPDX-License-Identifier: Apache-2.0
// Local MCP runtime step 3 — CRUD writes + log_activity run offline against
// LocalBackend with no login: write a memory through the real tool handler, read it
// back, and log an activity — all with the throwing-proxy supabase in play.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { writeMemoryTool } from "../tools/write-memory.js";
import { updateMemoryTool } from "../tools/update-memory.js";
import { readMemoryTool } from "../tools/read-memory.js";
import { logActivityTool } from "../tools/activity-log.js";
import { resetLocalBackends } from "../local-runtime.js";

afterEach(async () => {
  await resetLocalBackends();
});

describe("CRUD offline (LocalBackend)", () => {
  it("write_memory -> read_memory -> log_activity all succeed with no login", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-crud-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-crud-root-"));
    const prev = {
      home: process.env.PATHRULE_HOME,
      local: process.env.PATHRULE_LOCAL,
      principal: process.env.PATHRULE_LOCAL_PRINCIPAL,
      cwd: process.cwd(),
    };
    try {
      process.env.PATHRULE_HOME = home;
      process.env.PATHRULE_LOCAL = "1";
      process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";
      process.chdir(root);
      const canonicalRoot = process.cwd();

      const wid = randomUUID();
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
      seed.close();
      await resetLocalBackends();

      // write_memory
      const written = (await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/api",
        title: "Rate limit policy",
        content: "Throttle writes to 10/s per principal.",
      } as never)) as { ok?: boolean; id?: string };
      expect(written.ok).not.toBe(false);
      expect(written.id).toBeTruthy();

      // read_memory round-trips the same content
      const read = (await readMemoryTool.handler({ memory_id: written.id as string })) as {
        ok?: boolean;
      };
      expect(read.ok).not.toBe(false);
      expect(JSON.stringify(read)).toContain("Throttle writes to 10/s");

      // log_activity persists through the backend (no cloud telemetry)
      const logged = (await logActivityTool.handler({
        workspace_id: wid,
        domain: "backend",
        action: "create",
        scope: "service",
        task_summary: "added rate limit policy memory",
        files_touched: { total: 1, by_area: { api: ["src/limiter.ts"] } },
      } as never)) as { ok?: boolean };
      expect(logged.ok).not.toBe(false);
    } finally {
      process.chdir(prev.cwd);
      const restore = (
        k: "PATHRULE_HOME" | "PATHRULE_LOCAL" | "PATHRULE_LOCAL_PRINCIPAL",
        v?: string,
      ) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("PATHRULE_HOME", prev.home);
      restore("PATHRULE_LOCAL", prev.local);
      restore("PATHRULE_LOCAL_PRINCIPAL", prev.principal);
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  // related_paths used to stop at the tool in local mode (only the account edition stored them),
  // `[]` was turned into "unchanged", and a links-only update was refused unless the caller also
  // passed move_to_path pointing at the memory's own node.
  it("write_memory and update_memory carry related_paths to the store, links-only and [] included", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-links-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-links-root-"));
    const prev = {
      home: process.env.PATHRULE_HOME,
      local: process.env.PATHRULE_LOCAL,
      principal: process.env.PATHRULE_LOCAL_PRINCIPAL,
      cwd: process.cwd(),
    };
    try {
      process.env.PATHRULE_HOME = home;
      process.env.PATHRULE_LOCAL = "1";
      process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";
      process.chdir(root);
      const wid = randomUUID();
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: process.cwd() });
      seed.close();
      await resetLocalBackends();

      const linkedAt = async (path: string, id: string) => {
        const store = LocalBackend.openForWorkspace(wid, process.env);
        try {
          return (await store.relevantMemoriesForPath(wid, path)).some(
            (r) => r.memory_id === id && r.via === "context_link",
          );
        } finally {
          store.close();
        }
      };

      const written = (await writeMemoryTool.handler({
        workspace_id: wid,
        node_path: "/api",
        title: "Error envelope",
        content: "Handlers return { error }.",
        related_paths: [" web/ui/ ", "/api"],
      } as never)) as { ok?: boolean; id: string; related_paths?: string[] };
      expect(written.ok).toBe(true);
      expect(written.related_paths).toEqual(["/web/ui"]);
      await resetLocalBackends();
      expect(await linkedAt("/web/ui/Button.tsx", written.id)).toBe(true);

      const linksOnly = (await updateMemoryTool.handler({
        memory_id: written.id,
        related_paths: ["/docs"],
      } as never)) as { ok?: boolean; related_paths?: string[] };
      expect(linksOnly.ok).toBe(true);
      expect(linksOnly.related_paths).toEqual(["/docs"]);
      await resetLocalBackends();
      expect(await linkedAt("/docs", written.id)).toBe(true);
      expect(await linkedAt("/web/ui", written.id)).toBe(false);

      const cleared = (await updateMemoryTool.handler({
        memory_id: written.id,
        related_paths: [],
      } as never)) as { ok?: boolean };
      expect(cleared.ok).toBe(true);
      await resetLocalBackends();
      expect(await linkedAt("/docs", written.id)).toBe(false);

      const rejected = (await updateMemoryTool.handler({
        memory_id: written.id,
        related_paths: ["/"],
      } as never)) as { ok?: boolean; error?: string };
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).toContain("invalid_args");
    } finally {
      process.chdir(prev.cwd);
      const restore = (
        k: "PATHRULE_HOME" | "PATHRULE_LOCAL" | "PATHRULE_LOCAL_PRINCIPAL",
        v?: string,
      ) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("PATHRULE_HOME", prev.home);
      restore("PATHRULE_LOCAL", prev.local);
      restore("PATHRULE_LOCAL_PRINCIPAL", prev.principal);
      await resetLocalBackends();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
