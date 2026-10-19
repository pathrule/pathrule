// SPDX-License-Identifier: Apache-2.0
//
// Turning discovered sources into drafts. The behaviour that matters here is
// attribution: a nested file's knowledge must land on that package's node, and
// titles from different files must not collide. Then which drafts a store still
// lacks, the rule every writer shares.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { discoverKnowledgeSources } from "./discovery.js";
import {
  draftsBySource,
  importDiscoveredSources,
  missingDrafts,
  splitByPresence,
  type ImportableSource,
} from "./drafts.js";

const source = (over: Partial<ImportableSource>): ImportableSource => ({
  path: "CLAUDE.md",
  kind: "instruction",
  content: "# Overview\n\nStack is Electron.\n",
  suggestedNodePath: "/",
  ...over,
});

describe("importDiscoveredSources", () => {
  it("keeps root instruction titles unprefixed", () => {
    const drafts = importDiscoveredSources([source({})]);
    expect(drafts).toEqual([{ nodePath: "/", title: "Overview", content: "Stack is Electron." }]);
  });

  it("attributes a nested instruction file to its own package", () => {
    const drafts = importDiscoveredSources([
      source({
        path: "packages/api/CLAUDE.md",
        suggestedNodePath: "/packages/api",
        content: "# Runtime\n\nNode 20 only.\n",
      }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      nodePath: "/packages/api",
      title: "packages/api/CLAUDE.md: Runtime",
    });
    expect(drafts[0]!.content).toBe("Node 20 only.");
  });

  it("nests a path-like heading under the source's own directory", () => {
    const drafts = importDiscoveredSources([
      source({
        path: "packages/api/CLAUDE.md",
        suggestedNodePath: "/packages/api",
        content: "# src/handlers\n\nOne handler per file.\n",
      }),
    ]);
    expect(drafts[0]!.nodePath).toBe("/packages/api/src/handlers");
  });

  it("prefixes titles by origin so two files cannot collide", () => {
    const drafts = importDiscoveredSources([
      source({ content: "# Conventions\n\nRoot rule.\n" }),
      source({
        path: "docs/adr/007-queues.md",
        kind: "decision-record",
        content: "# Conventions\n\nADR rule.\n",
      }),
      source({
        path: ".cursor/rules/backend.mdc",
        kind: "tool-rule",
        content: "# Conventions\n\nCursor rule.\n",
      }),
    ]);

    expect(drafts.map((d) => d.title)).toEqual([
      "Conventions",
      "ADR 007-queues.md: Conventions",
      "backend.mdc: Conventions",
    ]);
    // Distinct titles mean three memories, not one overwriting the others.
    expect(new Set(drafts.map((d) => d.title)).size).toBe(3);
  });

  it("imports an @import target's content, which the old importer never read", () => {
    const drafts = importDiscoveredSources([
      source({
        path: "docs/architecture.md",
        kind: "import-target",
        content: "# Service map\n\nMonolith plus a worker.\n",
      }),
    ]);
    expect(drafts[0]).toMatchObject({ title: "docs/architecture.md: Service map" });
    expect(drafts[0]!.content).toBe("Monolith plus a worker.");
  });

  it("imports decision records, where the real rationale lives", () => {
    const drafts = importDiscoveredSources([
      source({
        path: "docs/adr/001-database.md",
        kind: "decision-record",
        content:
          "# ADR 001: Postgres over Mongo\n\n## Decision\nPostgres.\n\n## Rationale\nTransactions across billing rows.\n",
      }),
    ]);
    const all = JSON.stringify(drafts);
    expect(all).toContain("Postgres");
    expect(all).toContain("Transactions across billing rows");
  });

  it("does NOT auto-import general documents", () => {
    // A roadmap is mostly derivable and goes stale; importing it would bury the
    // conventions that are not derivable. Those are offered to the user instead.
    const drafts = importDiscoveredSources([
      source({
        path: "docs/plans/q3-roadmap.md",
        kind: "document",
        content: "# Q3 Roadmap\n\n- [x] Ship billing\n",
      }),
    ]);
    expect(drafts).toEqual([]);
  });

  it("returns nothing for an empty source list", () => {
    expect(importDiscoveredSources([])).toEqual([]);
  });
});

describe("which drafts a store still lacks", () => {
  it("groups drafts by source and never imports a document", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-drafts-"));
    const put = async (rel: string, body: string) => {
      await mkdir(join(root, rel, ".."), { recursive: true });
      await writeFile(join(root, rel), body, "utf8");
    };
    await put("CLAUDE.md", "# Acme\n\n## Style\n\nUse camelCase.\n");
    await put(".cursorrules", "Always write TypeScript strict mode.\n");
    await put("docs/adr/001-db.md", "# ADR 001\n\n## Decision\nPostgres.\n");
    await put("docs/plans/q3.md", "# Q3\n\n- [ ] Ship SSO\n");

    const bySource = draftsBySource(await discoverKnowledgeSources(root));

    const paths = bySource.map((s) => s.path);
    expect(paths).toEqual(
      expect.arrayContaining(["CLAUDE.md", ".cursorrules", "docs/adr/001-db.md"]),
    );
    expect(paths).not.toContain("docs/plans/q3.md");
    expect(JSON.stringify(bySource)).not.toContain("Ship SSO");
  });

  const bySource = [
    {
      path: "CLAUDE.md",
      drafts: [
        { nodePath: "/", title: "Style", content: "a" },
        { nodePath: "/", title: "Testing", content: "b" },
      ],
    },
    { path: ".claude/CLAUDE.md", drafts: [{ nodePath: "/", title: "Testing", content: "c" }] },
    { path: ".cursorrules", drafts: [{ nodePath: "/", title: "Cursor rules", content: "d" }] },
  ];

  it("calls a source in Pathrule only when every one of its drafts is there", () => {
    expect(splitByPresence(bySource, new Set(["Style", "Cursor rules"]))).toEqual({
      inPathrule: [".cursorrules"],
      notImported: ["CLAUDE.md", ".claude/CLAUDE.md"],
    });
  });

  it("returns only the titles the store never had, the first source winning a shared title", () => {
    expect(missingDrafts(bySource, new Set(["Style"]))).toEqual([
      { nodePath: "/", title: "Testing", content: "b" },
      { nodePath: "/", title: "Cursor rules", content: "d" },
    ]);
    expect(missingDrafts(bySource, new Set(["Style", "Testing", "Cursor rules"]))).toEqual([]);
  });
});
