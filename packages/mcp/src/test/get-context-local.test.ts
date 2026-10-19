// SPDX-License-Identifier: Apache-2.0
import { removeScratch } from "./scratch.js";
import { createHash } from "node:crypto";
import { recordLearningTool } from "../tools/record-learning.js";
// Local MCP runtime — end-to-end proof that get_context runs offline against a
// LocalBackend (no auth, no Supabase): write a memory locally, then read it back
// through the real tool handler in PATHRULE_LOCAL mode. This is the loop-closer.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@pathrule/core";
import { normalizeFilesTouched } from "@pathrule/protocol/normalize-workspace-path.js";
import { getContextTool } from "../tools/get-context.js";
import { readMemoryTool } from "../tools/read-memory.js";
import { setProjectLearningBudgetForTest } from "../tools/get-context-learning.js";
import { resetLocalBackends } from "../local-runtime.js";

// These cases assert learning content, not the latency budget; a loaded CI machine must
// not turn them into a race against it.
beforeEach(() => setProjectLearningBudgetForTest(30_000));
afterEach(async () => {
  setProjectLearningBudgetForTest(null);
  await resetLocalBackends();
});

async function pollForHookIndex(
  indexPath: string,
  timeoutMs = 5_000,
): Promise<{ workspace_root?: string } & Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(readFileSync(indexPath, "utf8")) as {
        workspace_root?: string;
      } & Record<string, unknown>;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("get_context offline (LocalBackend)", () => {
  it("resolves the local workspace and surfaces a locally-written memory, no login", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-gc-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-gc-root-"));
    const prevHome = process.env.PATHRULE_HOME;
    const prevLocal = process.env.PATHRULE_LOCAL;
    const prevPrincipal = process.env.PATHRULE_LOCAL_PRINCIPAL;
    const prevCwd = process.cwd();
    try {
      process.env.PATHRULE_HOME = home;
      process.env.PATHRULE_LOCAL = "1";
      process.env.PATHRULE_LOCAL_PRINCIPAL = "tester";

      // chdir first, then register the canonical cwd as the root — on macOS the mkdtemp
      // path (/var/...) and process.cwd() (/private/var/...) differ via a symlink, so we
      // anchor on what discovery will actually see.
      process.chdir(root);
      const canonicalRoot = process.cwd();
      writeFileSync(join(canonicalRoot, "package.json"), '{"name":"offline-fixture"}');

      const wid = "ws-gc-e2e";
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
      const node = await seed.ensureNodeForPath(wid, "/");
      await seed.writeMemory({
        workspaceId: wid,
        nodeId: node.id,
        title: "Deploy ritual",
        content: "Run the release gate before pushing.",
        source: "claude",
      });
      await seed.logActivity({
        workspaceId: wid,
        domain: "backend",
        action: "fix",
        scope: "service",
        taskSummary: "private summary not needed for learning priorities",
        filesTouched: normalizeFilesTouched({ by_area: { code: ["src/deploy.ts"] } }, canonicalRoot)
          .normalized,
      });
      seed.close();
      await resetLocalBackends();

      const sourceBody = readFileSync(join(canonicalRoot, "package.json"));
      const learning = (await recordLearningTool.handler({
        cwd: canonicalRoot,
        node_path: "/",
        topic: "Package identity",
        statement: "The package is named offline-fixture.",
        category: "architecture",
        sources: [
          {
            path: "package.json",
            digest: `sha256:${createHash("sha256").update(sourceBody).digest("hex")}`,
          },
        ],
      })) as { ok: boolean; id: string };
      expect(learning.ok).toBe(true);

      // The local runtime discovers the workspace from process.cwd() (already chdir'd).
      const result = await getContextTool.handler({ user_intent: "how do I deploy" } as never);

      if ((result as { ok?: boolean }).ok === false) {
        throw new Error(`handler returned error: ${JSON.stringify(result)}`);
      }
      expect(JSON.stringify(result)).toContain("Deploy ritual");

      // No user_intent forces deep depth — exercises buildDeepBriefing offline (it must
      // skip the git/cloud bootstrap branch + cloud-only enrichment when local).
      const deep = await getContextTool.handler({} as never);
      if ((deep as { ok?: boolean }).ok === false) {
        throw new Error(`deep handler returned error: ${JSON.stringify(deep)}`);
      }
      expect((deep as { context_depth?: string }).context_depth).toBe("deep");
      expect((deep as { project_map?: { modules: unknown[] } }).project_map?.modules).toEqual([
        expect.objectContaining({
          name: "offline-fixture",
          evidence: { path: "package.json", digest: expect.stringMatching(/^sha256:/) },
        }),
      ]);
      expect(
        (deep as { activity_leads?: { targets: unknown[] } }).activity_leads?.targets,
      ).toEqual([expect.objectContaining({ path: "src/deploy.ts", needs: "source_verification" })]);

      // Agent-recorded and current here, so it is context with no human step.
      const learned = (deep as { project_learning_claims: { claims: Array<{ id: string }> } })
        .project_learning_claims;
      expect(learned.claims[0]?.id).toBe(learning.id);
      expect(learned).not.toHaveProperty("unreviewed");
      writeFileSync(join(canonicalRoot, "package.json"), '{"name":"changed-package"}');
      const stale = (await getContextTool.handler({} as never)) as {
        project_learning_claims: { claims: unknown[]; withheld: Array<{ reason: string }> };
      };
      expect(stale.project_learning_claims.claims).toEqual([]);
      expect(stale.project_learning_claims.withheld[0]?.reason).toBe("stale");
      const rejected = (await recordLearningTool.handler({
        cwd: canonicalRoot,
        node_path: "/",
        topic: "Package identity",
        statement: "Outdated interpretation",
        category: "architecture",
        sources: [
          {
            path: "package.json",
            digest: `sha256:${createHash("sha256").update(sourceBody).digest("hex")}`,
          },
        ],
      })) as { ok: boolean };
      expect(rejected.ok).toBe(false);
      const forgedReview = (await recordLearningTool.handler({
        cwd: canonicalRoot,
        node_path: "/",
        topic: "Unverified review",
        statement: "Must not accept invented review provenance",
        category: "decision",
        sources: [
          {
            path: "package.json",
            digest: `sha256:${createHash("sha256")
              .update(readFileSync(join(canonicalRoot, "package.json")))
              .digest("hex")}`,
          },
        ],
        review_sources: [
          {
            repository: "team/project",
            pullRequest: 1,
            kind: "review",
            id: 11,
            digest: `sha256:${"b".repeat(64)}`,
            commit: "a".repeat(40),
            mergedAt: "2026-09-20T00:00:00Z",
            association: "MEMBER",
            state: "COMMENTED",
          },
        ],
      })) as { ok: boolean; error: { code: string } };
      expect(forgedReview).toMatchObject({
        ok: false,
        error: { code: "review_verification_required" },
      });

      // Offline hooks (4.4): get_context refreshed the local hook-index file the
      // PreToolUse/UserPromptSubmit hook reads — no daemon, no cloud. The write is
      // deliberately fire-and-forget in the handler (`void syncHookIndex(...)`), so
      // poll briefly instead of racing it with a synchronous read.
      const indexPath = join(home, "cache", wid, "hook-index.json");
      const index = await pollForHookIndex(indexPath);
      expect(index.workspace_root).toBe(canonicalRoot);
      expect(JSON.stringify(index)).toContain("Deploy ritual");
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.PATHRULE_HOME;
      else process.env.PATHRULE_HOME = prevHome;
      if (prevLocal === undefined) delete process.env.PATHRULE_LOCAL;
      else process.env.PATHRULE_LOCAL = prevLocal;
      if (prevPrincipal === undefined) delete process.env.PATHRULE_LOCAL_PRINCIPAL;
      else process.env.PATHRULE_LOCAL_PRINCIPAL = prevPrincipal;
      removeScratch(home);
      removeScratch(root);
    }
  });

  // Knowledge under an `_archive` node describes removed code: default context leaves it out (the
  // overview and the hook index get_context writes), while a read by id still reaches it.
  it("leaves archived knowledge out of the overview and the hook index, and still reads it by id", async () => {
    const home = mkdtempSync(join(tmpdir(), "pathrule-gc-archive-home-"));
    const root = mkdtempSync(join(tmpdir(), "pathrule-gc-archive-root-"));
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
      const wid = "ws-gc-archive";
      const seed = LocalBackend.openForWorkspace(wid, process.env);
      seed.registerWorkspace({ workspaceId: wid, name: "demo", localRootPath: canonicalRoot });
      const live = await seed.ensureNodeForPath(wid, "/api");
      const archive = await seed.ensureNodeForPath(wid, "/_archive/studio");
      await seed.writeMemory({
        workspaceId: wid,
        nodeId: live.id,
        title: "Queue retry policy",
        content: "Retry twice, then dead-letter.",
        source: "claude",
      });
      const archived = await seed.writeMemory({
        workspaceId: wid,
        nodeId: archive.id,
        title: "Archived queue retry policy",
        content: "How Studio retried its queue.",
        source: "claude",
      });
      seed.close();
      await resetLocalBackends();

      const deep = (await getContextTool.handler({} as never)) as {
        workspace_overview?: Array<{ relative_path: string }>;
      };
      const paths = (deep.workspace_overview ?? []).map((n) => n.relative_path);
      expect(paths).toContain("/api");
      expect(paths.some((p) => p.startsWith("/_archive"))).toBe(false);

      const index = await pollForHookIndex(join(home, "cache", wid, "hook-index.json"));
      expect(JSON.stringify(index)).toContain("Queue retry policy");
      expect(JSON.stringify(index)).not.toContain("Archived queue retry policy");

      const read = await readMemoryTool.handler({ memory_id: archived.id } as never);
      expect(JSON.stringify(read)).toContain("How Studio retried its queue.");
    } finally {
      process.chdir(prev.cwd);
      for (const [key, value] of [
        ["PATHRULE_HOME", prev.home],
        ["PATHRULE_LOCAL", prev.local],
        ["PATHRULE_LOCAL_PRINCIPAL", prev.principal],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeScratch(home);
      removeScratch(root);
    }
  });
});
