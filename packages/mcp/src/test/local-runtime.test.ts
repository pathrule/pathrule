// SPDX-License-Identifier: Apache-2.0
// Local MCP runtime: composition seam tests. A Local folder's call gets a LocalBackend-backed
// ToolContext with no auth; folder-mode-context.test.ts covers which edition serves a folder.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { resolveOpenContext, resetLocalBackends } from "../local-runtime.js";
import type { RemoteStore } from "@pathrule/host/remote-store.js";

function makeEnv(home: string): NodeJS.ProcessEnv {
  return { PATHRULE_HOME: home, PATHRULE_LOCAL_PRINCIPAL: "tester" } as NodeJS.ProcessEnv;
}

afterEach(async () => {
  await resetLocalBackends();
});

describe("resolveOpenContext in a Local folder", () => {
  it("opens the local store for an explicit workspaceId and stamps the local principal", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-local-rt-"));
    try {
      const env = makeEnv(home);
      const wid = "ws-local-test";
      const backend = LocalBackend.openForWorkspace(wid, env);
      backend.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: home });
      backend.close();

      const ctx = await resolveOpenContext(wid, env);
      expect(ctx.workspaceId).toBe(wid);
      expect(ctx.userId).toBe("tester");
      // The store the host serves: it answers for the workspace registered above.
      expect(await (ctx.backend as unknown as RemoteStore).getWorkspaceName(wid)).toBe("demo");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("carries no account client: the local store is the whole context", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-local-rt-"));
    try {
      const env = makeEnv(home);
      const wid = "ws-proxy-test";
      const backend = LocalBackend.openForWorkspace(wid, env);
      backend.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: home });
      backend.close();

      const ctx = await resolveOpenContext(wid, env);
      expect("supabase" in ctx).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws an actionable error when no workspace covers the cwd and none is given", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-local-rt-"));
    try {
      const env = makeEnv(home);
      await expect(resolveOpenContext(null, env)).rejects.toThrow(/pathrule init --local/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reuses one store across calls (cached)", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-local-rt-"));
    try {
      const env = makeEnv(home);
      const wid = "ws-cache-test";
      const backend = LocalBackend.openForWorkspace(wid, env);
      backend.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: home });
      backend.close();

      const a = await resolveOpenContext(wid, env);
      const b = await resolveOpenContext(wid, env);
      expect(a.backend).toBe(b.backend);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
