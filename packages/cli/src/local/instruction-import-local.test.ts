// SPDX-License-Identifier: Apache-2.0
// The project's instruction files, imported into a local store.
//
// Studio and the Cloud setup import CLAUDE.md, AGENTS.md, tool rules and
// decision records word for word. A Core workspace did not, so a user without an
// account started from nothing even when the project had written everything
// down. These run against a real SQLite store.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { PATHRULE_REGION, mergeRegionInto } from "@pathrule/core/paths/region.js";
import { importLocalInstructions } from "./instruction-import-local.js";

const WS = "ws-instructions-local";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
  tmps.length = 0;
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

function put(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
}

function repoWithInstructions(): string {
  const root = freshDir("pathrule-local-instr-");
  const put = (rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body, "utf8");
  };
  put("CLAUDE.md", "# Acme\n\n## Style\n\nUse camelCase.\n\n## Testing\n\nRun pnpm test.\n");
  put("packages/api/AGENTS.md", "## Errors\n\nWrap every handler error in ApiError.\n");
  put(".cursorrules", "Always write TypeScript strict mode.\n");
  put("docs/adr/001-db.md", "# ADR 001\n\n## Rationale\nNever use Mongo for billing.\n");
  put("docs/plans/q3.md", "# Q3\n\n- [ ] Ship SSO\n");
  return root;
}

function openStore(root: string): LocalBackend {
  const env = { PATHRULE_HOME: freshDir("pathrule-local-instr-home-") } as NodeJS.ProcessEnv;
  const backend = LocalBackend.openForWorkspace(WS, env);
  backend.registerWorkspace({ workspaceId: WS, name: "acme", localRootPath: root });
  return backend;
}

async function memories(backend: LocalBackend) {
  const rows = await backend.listMemories({ workspaceId: WS });
  return Promise.all(
    rows.map(async (m) => ({
      title: m.title,
      content: m.content,
      source: m.source,
      path: m.nodeId ? (await backend.getNode(m.nodeId))?.relativePath : null,
    })),
  );
}

describe("importLocalInstructions", () => {
  it("imports every instruction file word for word, each on the folder it describes", async () => {
    const root = repoWithInstructions();
    const backend = openStore(root);
    try {
      const result = await importLocalInstructions({
        backend,
        workspaceId: WS,
        workspaceRoot: root,
        mode: "missing",
      });

      const rows = await memories(backend);
      expect(rows).toContainEqual(
        expect.objectContaining({ title: "Style", content: "Use camelCase.", path: "/" }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          title: "packages/api/AGENTS.md: Errors",
          content: "Wrap every handler error in ApiError.",
          path: "/packages/api",
        }),
      );
      expect(rows.every((row) => row.source === "manual")).toBe(true);
      expect(JSON.stringify(rows)).toContain("Never use Mongo for billing");
      // A plan is mostly derivable and goes stale; it is offered, never imported.
      expect(JSON.stringify(rows)).not.toContain("Ship SSO");
      expect(result).toEqual({
        imported: rows.length,
        failed: 0,
        inPathrule: expect.arrayContaining([
          "CLAUDE.md",
          "packages/api/AGENTS.md",
          ".cursorrules",
          "docs/adr/001-db.md",
        ]),
        notImported: [],
      });
    } finally {
      backend.close();
    }
  });

  it("imports nothing twice", async () => {
    const root = repoWithInstructions();
    const backend = openStore(root);
    try {
      const args = { backend, workspaceId: WS, workspaceRoot: root, mode: "missing" as const };
      await importLocalInstructions(args);
      const before = (await memories(backend)).length;

      const again = await importLocalInstructions(args);

      expect(again?.imported).toBe(0);
      expect((await memories(backend)).length).toBe(before);
    } finally {
      backend.close();
    }
  });

  it("leaves a workspace with content alone in ifEmpty mode and names what it lacks", async () => {
    const root = repoWithInstructions();
    const backend = openStore(root);
    try {
      const node = await backend.ensureNodeForPath(WS, "/");
      await backend.writeMemory({ workspaceId: WS, nodeId: node.id, title: "Mine", content: "x" });

      const result = await importLocalInstructions({
        backend,
        workspaceId: WS,
        workspaceRoot: root,
        mode: "ifEmpty",
      });

      expect((await memories(backend)).map((row) => row.title)).toEqual(["Mine"]);
      expect(result?.imported).toBe(0);
      expect(result?.inPathrule).toEqual([]);
      expect(result?.notImported).toEqual(
        expect.arrayContaining(["CLAUDE.md", "packages/api/AGENTS.md"]),
      );
    } finally {
      backend.close();
    }
  });

  it("imports into an existing workspace that is still empty in ifEmpty mode", async () => {
    const root = repoWithInstructions();
    const backend = openStore(root);
    try {
      const result = await importLocalInstructions({
        backend,
        workspaceId: WS,
        workspaceRoot: root,
        mode: "ifEmpty",
      });

      expect(result?.imported).toBeGreaterThan(0);
      expect(result?.notImported).toEqual([]);
    } finally {
      backend.close();
    }
  });

  it("does not bring back a section someone removed", async () => {
    const root = repoWithInstructions();
    const backend = openStore(root);
    try {
      const args = { backend, workspaceId: WS, workspaceRoot: root, mode: "missing" as const };
      await importLocalInstructions(args);
      const testing = (await backend.listMemories({ workspaceId: WS })).find(
        (m) => m.title === "Testing",
      );
      await backend.deleteMemory({ id: testing!.id });

      const again = await importLocalInstructions(args);

      expect(again?.imported).toBe(0);
      expect((await memories(backend)).map((row) => row.title)).not.toContain("Testing");
      // Removed on purpose is still "in Pathrule": the file is not offered again.
      expect(again?.inPathrule).toContain("CLAUDE.md");
    } finally {
      backend.close();
    }
  });

  it("returns null for a folder with no instruction files", async () => {
    const root = freshDir("pathrule-local-instr-empty-");
    writeFileSync(join(root, "index.ts"), "export {};\n", "utf8");
    const backend = openStore(root);
    try {
      expect(
        await importLocalInstructions({
          backend,
          workspaceId: WS,
          workspaceRoot: root,
          mode: "missing",
        }),
      ).toBeNull();
      expect(await memories(backend)).toEqual([]);
    } finally {
      backend.close();
    }
  });

  describe("files Pathrule wrote", () => {
    // What a Pathrule Cloud sync leaves in a folder (U+2014 is the renderers' dash).
    const BANNER = "<!-- Pathrule managed \u2014 do not edit; cloud state is authoritative. -->";
    const CLOUD = `${BANNER}\n\n# Pathrule integration\n\n## Cloud knowledge\n\nFrom Pathrule Cloud.\n`;

    function repoAfterCloudSync(): { root: string; files: Record<string, string> } {
      const root = freshDir("pathrule-local-instr-cloud-");
      const files: Record<string, string> = {
        "CLAUDE.md": mergeRegionInto("# Acme\n\n## Style\n\nUse camelCase.\n", CLOUD),
        "AGENTS.md": `## Release\n\nShip on Tuesdays.\n\n${CLOUD}${PATHRULE_REGION.end}\n`,
        "packages/api/CLAUDE.md": `${BANNER}\n# Project knowledge\n\nFrom Pathrule Cloud.\n`,
        ".cursor/rules/pathrule-protocol.mdc": CLOUD,
        ".github/instructions/pathrule.instructions.md": CLOUD,
        ".github/copilot-instructions.md": CLOUD,
        ".claude/rules/notes.md": "## Notes\n\nFrom Pathrule Cloud, no banner.\n",
        ".pathrule/managed-files.json": JSON.stringify({
          schema_version: 1,
          files: [
            {
              path: ".claude/rules/notes.md",
              owner: "cli",
              owner_version: "1.0.0",
              updated_at: "2026-10-01T00:00:00.000Z",
            },
          ],
        }),
        "docs/adr/001-db.md": "# ADR 001\n\n## Rationale\nNever use Mongo for billing.\n",
      };
      for (const [rel, body] of Object.entries(files)) put(root, rel, body);
      return { root, files };
    }

    it("imports only the person's text and reports every file it left out", async () => {
      const { root, files } = repoAfterCloudSync();
      const backend = openStore(root);
      try {
        const result = await importLocalInstructions({
          backend,
          workspaceId: WS,
          workspaceRoot: root,
          mode: "missing",
        });

        const rows = await memories(backend);
        expect(rows.map((row) => row.title).sort()).toEqual([
          "ADR 001-db.md: ADR 001",
          "ADR 001-db.md: Rationale",
          "Acme",
          "Style",
        ]);
        expect(JSON.stringify(rows)).not.toContain("From Pathrule Cloud");
        expect(JSON.stringify(rows)).not.toContain("Ship on Tuesdays");
        expect(result).toEqual({
          imported: 4,
          failed: 0,
          inPathrule: ["CLAUDE.md", "docs/adr/001-db.md"],
          notImported: [],
          skipped: [
            { path: ".claude/rules/notes.md", reason: "managed_file" },
            { path: ".cursor/rules/pathrule-protocol.mdc", reason: "pathrule_written" },
            { path: ".github/copilot-instructions.md", reason: "pathrule_banner" },
            { path: ".github/instructions/pathrule.instructions.md", reason: "pathrule_written" },
            { path: "AGENTS.md", reason: "unbalanced_marker" },
            { path: "packages/api/CLAUDE.md", reason: "pathrule_banner" },
          ],
        });
        // The import only reads.
        for (const [rel, body] of Object.entries(files)) {
          expect(readFileSync(join(root, rel), "utf8")).toBe(body);
        }
      } finally {
        backend.close();
      }
    });

    it("reports a folder holding only Pathrule's files instead of returning null", async () => {
      const root = freshDir("pathrule-local-instr-only-cloud-");
      put(root, ".cursor/rules/pathrule-protocol.mdc", CLOUD);
      put(root, "CLAUDE.md", mergeRegionInto(null, CLOUD));
      const backend = openStore(root);
      try {
        expect(
          await importLocalInstructions({
            backend,
            workspaceId: WS,
            workspaceRoot: root,
            mode: "missing",
          }),
        ).toEqual({
          imported: 0,
          failed: 0,
          inPathrule: [],
          notImported: [],
          skipped: [
            { path: ".cursor/rules/pathrule-protocol.mdc", reason: "pathrule_written" },
            { path: "CLAUDE.md", reason: "pathrule_written" },
          ],
        });
        expect(await memories(backend)).toEqual([]);
      } finally {
        backend.close();
      }
    });

    it("adds no skipped list when nothing was left out", async () => {
      const root = repoWithInstructions();
      const backend = openStore(root);
      try {
        const result = await importLocalInstructions({
          backend,
          workspaceId: WS,
          workspaceRoot: root,
          mode: "missing",
        });
        expect(result).not.toHaveProperty("skipped");
      } finally {
        backend.close();
      }
    });
  });
});
