// SPDX-License-Identifier: Apache-2.0
//
// Discovery must find knowledge wherever a project already keeps it. The five
// repo kinds here are the same population as integration-scenarios.test.ts, so
// the two suites can be read against each other.

import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PATHRULE_REGION, mergeRegionInto } from "../paths/region.js";
import {
  discoverKnowledgeSources,
  inventoryKnowledgeSources,
  parseImportTargets,
  suggestedNodePathFor,
} from "./discovery.js";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pathrule-discovery-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
  return root;
}

const paths = (sources: Awaited<ReturnType<typeof discoverKnowledgeSources>>) =>
  sources.map((s) => s.path);

describe("parseImportTargets", () => {
  it("finds imports and ignores code samples", () => {
    const body = [
      "See @docs/architecture.md for the map.",
      "",
      "```bash",
      "# @docs/not-an-import.md",
      "```",
      "",
      "Inline `@docs/also-not.md` stays literal.",
      "- git workflow @docs/git.md",
    ].join("\n");
    expect(parseImportTargets(body)).toEqual(["docs/architecture.md", "docs/git.md"]);
  });

  it("skips home-relative imports and extension-less mentions", () => {
    expect(parseImportTargets("@~/.claude/mine.md and @someone")).toEqual([]);
  });

  it("deduplicates", () => {
    expect(parseImportTargets("@a/b.md then @a/b.md again")).toEqual(["a/b.md"]);
  });
});

describe("suggestedNodePathFor", () => {
  it("derives the node path from the file's directory", () => {
    expect(suggestedNodePathFor("CLAUDE.md")).toBe("/");
    expect(suggestedNodePathFor("packages/api/CLAUDE.md")).toBe("/packages/api");
    expect(suggestedNodePathFor("Sources/Networking/AGENTS.md")).toBe("/Sources/Networking");
  });

  it("does not attribute knowledge to a tool directory", () => {
    expect(suggestedNodePathFor(".claude/CLAUDE.md")).toBe("/");
    expect(suggestedNodePathFor(".cursor/rules/backend.mdc")).toBe("/");
    expect(suggestedNodePathFor(".github/instructions/api.md")).toBe("/");
  });
});

describe("scenario C: the deeply @imported tree", () => {
  it("follows the import chain the old importer never read", async () => {
    const root = await repo({
      "CLAUDE.md":
        "# Acme\n\nSee @docs/architecture.md and @.claude/conventions/api.md.\n\n## Setup\n\n```bash\n# @docs/fake.md\npnpm install\n```\n",
      "docs/architecture.md": "# Architecture\n\nService map lives here.\n\nAlso @docs/deep.md\n",
      "docs/deep.md": "# Deep\n\nSecond hop.\n",
      ".claude/conventions/api.md": "# API conventions\n\nAlways version endpoints.\n",
      "packages/api/CLAUDE.md": "# API package\n\nNode 20 only.\n",
    });

    const sources = await discoverKnowledgeSources(root);
    const found = paths(sources);

    // Instruction files, including the nested one.
    expect(found).toContain("CLAUDE.md");
    expect(found).toContain("packages/api/CLAUDE.md");
    // Import targets, transitively (two hops).
    expect(found).toContain("docs/architecture.md");
    expect(found).toContain("docs/deep.md");
    expect(found).toContain(".claude/conventions/api.md");
    // The fenced sample is not an import.
    expect(found).not.toContain("docs/fake.md");

    // Content is carried, so the caller can actually import it.
    const arch = sources.find((s) => s.path === "docs/architecture.md")!;
    expect(arch.kind).toBe("import-target");
    expect(arch.content).toContain("Service map lives here");
    expect(arch.importedBy).toBe("CLAUDE.md");

    // The nested file is attributed to its own package.
    expect(sources.find((s) => s.path === "packages/api/CLAUDE.md")!.suggestedNodePath).toBe(
      "/packages/api",
    );
  });
});

describe("scenario D: the Cursor-first repo", () => {
  it("finds tool rules the old importer returned nothing for", async () => {
    const root = await repo({
      ".cursorrules": "Always write TypeScript strict mode.\n",
      ".cursor/rules/backend.mdc":
        '---\nglobs: "services/api/**"\n---\n# Backend\n\nUse the repository pattern.\n',
      ".cursor/rules/pathrule-protocol.mdc": "<!-- Pathrule managed -->\nours, not theirs\n",
      ".claude/rules/pathrule/workspace.md": "<!-- Pathrule managed -->\nours too\n",
      ".windsurfrules": "Two-space indent.\n",
      ".github/copilot-instructions.md": "# Copilot\n\nPrefer async/await.\n",
      ".claude/rules/testing.md": "# Testing\n\nVitest only.\n",
    });

    const found = paths(await discoverKnowledgeSources(root));

    expect(found).toContain(".cursorrules");
    expect(found).toContain(".cursor/rules/backend.mdc");
    expect(found).toContain(".windsurfrules");
    expect(found).toContain(".github/copilot-instructions.md");
    expect(found).toContain(".claude/rules/testing.md");
    // Pathrule's own generated files are not the user's knowledge.
    expect(found).not.toContain(".cursor/rules/pathrule-protocol.mdc");
    expect(found).not.toContain(".claude/rules/pathrule/workspace.md");
  });
});

describe("scenario B: thin instructions, rich documents", () => {
  it("separates decision records from general docs", async () => {
    const root = await repo({
      "CLAUDE.md": "# Acme\n\nRun pnpm dev.\n",
      "docs/adr/001-database.md":
        "# ADR 001: Postgres over Mongo\n\n## Decision\nPostgres.\n\n## Rationale\nTransactions across billing rows.\n",
      "docs/decisions/002-queue.md": "# Use SQS\n\n## Decision\nSQS.\n",
      "docs/architecture.md": "# Architecture\n\nMonolith with a worker queue.\n",
      "docs/plans/q3-roadmap.md": "# Q3 Roadmap\n\n- [x] Ship billing\n",
    });

    const sources = await discoverKnowledgeSources(root);
    const kindOf = (p: string) => sources.find((s) => s.path === p)?.kind;

    // The decision that used to be invisible is now found, and typed as the
    // high-value kind rather than lumped in with roadmaps.
    expect(kindOf("docs/adr/001-database.md")).toBe("decision-record");
    expect(kindOf("docs/decisions/002-queue.md")).toBe("decision-record");
    expect(kindOf("docs/architecture.md")).toBe("document");
    expect(kindOf("docs/plans/q3-roadmap.md")).toBe("document");

    const adr = sources.find((s) => s.path === "docs/adr/001-database.md")!;
    expect(adr.content).toContain("Postgres");
    expect(adr.content).toContain("Transactions across billing rows");
  });
});

describe("scenario A and E: nothing invented, nothing vendored", () => {
  it("returns nothing for an empty project", async () => {
    expect(await discoverKnowledgeSources(await repo({}))).toEqual([]);
  });

  it("skips vendored trees and non-markdown files", async () => {
    const root = await repo({
      "CLAUDE.md": "# Acme\n",
      "node_modules/pkg/CLAUDE.md": "vendored\n",
      "dist/CLAUDE.md": "built\n",
      ".venv/lib/AGENTS.md": "vendored\n",
      "rag/ingest.py": "# chunk and embed\n",
      "src/index.ts": "export {};\n",
    });

    expect(paths(await discoverKnowledgeSources(root))).toEqual(["CLAUDE.md"]);
  });

  it("ignores an empty instruction file", async () => {
    const root = await repo({ "CLAUDE.md": "   \n\n", "AGENTS.md": "# real\n" });
    expect(paths(await discoverKnowledgeSources(root))).toEqual(["AGENTS.md"]);
  });
});

describe("ordering", () => {
  it("returns instruction files first, then imports, then tool rules, then decisions, then docs", async () => {
    const root = await repo({
      "CLAUDE.md": "# Acme\n\nSee @docs/architecture.md.\n",
      "docs/architecture.md": "# Architecture\n",
      ".cursorrules": "strict\n",
      "docs/adr/001.md": "# ADR\n",
      "docs/guide.md": "# Guide\n",
    });

    expect((await discoverKnowledgeSources(root)).map((s) => s.kind)).toEqual([
      "instruction",
      "import-target",
      "tool-rule",
      "decision-record",
      "document",
    ]);
  });
});

describe("nothing Pathrule wrote is a source", () => {
  // The renderers' banners, spelled as they write them (U+2014 is their dash).
  const CLIENT_BANNER =
    "<!-- Pathrule managed \u2014 do not edit; cloud state is authoritative. -->";
  const ROOT_BANNER =
    "<!-- managed by Pathrule \u2014 do not edit this file manually. Cloud state is authoritative. Local edits are overwritten. -->";
  const CLOUD_BODY = `${CLIENT_BANNER}\n\n# Pathrule integration\n\n## Workspace knowledge (Pathrule)\n\nCloud only.\n`;
  const PERSON = "# Acme\n\n## Style\n\nUse camelCase.\n";
  const ledger = (paths: string[]) =>
    JSON.stringify({
      schema_version: 1,
      files: paths.map((path) => ({
        path,
        owner: "cli",
        owner_version: "1.0.0",
        updated_at: "2026-10-01T00:00:00.000Z",
      })),
    });

  it("skips a legacy banner-only CLAUDE.md", async () => {
    const root = await repo({
      "CLAUDE.md": `${ROOT_BANNER}\n\n# Pathrule Workspace\n\n## Writes\n\nCloud only.\n`,
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual([]);
    expect(skipped).toEqual([
      { path: "CLAUDE.md", kind: "instruction", reason: "pathrule_banner" },
    ]);
  });

  it("imports only the person's text from a CLAUDE.md with an intact region", async () => {
    const root = await repo({ "CLAUDE.md": mergeRegionInto(PERSON, CLOUD_BODY) });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(sources.map((s) => [s.path, s.content])).toEqual([["CLAUDE.md", PERSON.trim()]]);
    expect(skipped).toEqual([]);
  });

  it("imports only the person's text from an AGENTS.md with an intact region", async () => {
    const root = await repo({
      "packages/api/AGENTS.md": mergeRegionInto("## Errors\n\nWrap them.\n", CLOUD_BODY),
    });
    const [source] = (await inventoryKnowledgeSources(root)).sources;
    expect(source?.path).toBe("packages/api/AGENTS.md");
    expect(source?.content).toBe("## Errors\n\nWrap them.");
  });

  it("imports nothing from a file whose begin marker was deleted, and reports it", async () => {
    const body = mergeRegionInto(PERSON, CLOUD_BODY).replace(`${PATHRULE_REGION.begin}\n`, "");
    const root = await repo({ "CLAUDE.md": body });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(sources).toEqual([]);
    expect(skipped).toEqual([
      { path: "CLAUDE.md", kind: "instruction", reason: "unbalanced_marker" },
    ]);
  });

  it("imports nothing from a file whose region never ends", async () => {
    const root = await repo({
      "AGENTS.md": `${PERSON}\n${PATHRULE_REGION.begin}\n${CLOUD_BODY}`,
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(sources).toEqual([]);
    expect(skipped).toEqual([
      { path: "AGENTS.md", kind: "instruction", reason: "unbalanced_marker" },
    ]);
  });

  it("skips Copilot's and Cursor's Pathrule files by name", async () => {
    const root = await repo({
      ".github/instructions/pathrule.instructions.md": `---\napplyTo: "**"\n---\n\n# Pathrule integration\n`,
      ".github/instructions/api.instructions.md": "# API\n\nVersion every endpoint.\n",
      ".cursor/rules/pathrule-protocol.mdc":
        "---\nalwaysApply: true\n---\n# Pathrule integration\n",
      ".cursor/rules/backend.mdc": "# Backend\n\nUse the repository pattern.\n",
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual([
      ".cursor/rules/backend.mdc",
      ".github/instructions/api.instructions.md",
    ]);
    expect(skipped).toEqual([
      {
        path: ".cursor/rules/pathrule-protocol.mdc",
        kind: "tool-rule",
        reason: "pathrule_written",
      },
      {
        path: ".github/instructions/pathrule.instructions.md",
        kind: "tool-rule",
        reason: "pathrule_written",
      },
    ]);
  });

  it("skips .github/copilot-instructions.md only when it carries a Pathrule banner", async () => {
    const written = await repo({
      ".github/copilot-instructions.md": `${CLIENT_BANNER}\n\n# Pathrule integration\n\nCloud only.\n`,
    });
    expect(await inventoryKnowledgeSources(written)).toEqual({
      sources: [],
      skipped: [
        { path: ".github/copilot-instructions.md", kind: "tool-rule", reason: "pathrule_banner" },
      ],
    });

    const own = "# Copilot\n\nPrefer async/await.\n";
    const theirs = await repo({ ".github/copilot-instructions.md": own });
    const { sources, skipped } = await inventoryKnowledgeSources(theirs);
    expect(sources.map((s) => [s.path, s.content])).toEqual([
      [".github/copilot-instructions.md", own],
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips a file managed-files.json lists, however ordinary it reads", async () => {
    const root = await repo({
      ".pathrule/managed-files.json": ledger([".claude/rules/testing.md"]),
      ".claude/rules/testing.md": "# Testing\n\nVitest only.\n",
      ".claude/rules/style.md": "# Style\n\nTwo-space indent.\n",
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual([".claude/rules/style.md"]);
    expect(skipped).toEqual([
      { path: ".claude/rules/testing.md", kind: "tool-rule", reason: "managed_file" },
    ]);
  });

  it("reads the ledger of a folder bound on its own, relative to that folder", async () => {
    const root = await repo({
      "packages/api/.pathrule/managed-files.json": ledger(["CLAUDE.md"]),
      "packages/api/CLAUDE.md": "# API\n\nCloud wrote this without a banner.\n",
      "packages/web/CLAUDE.md": "# Web\n\nNext.js only.\n",
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual(["packages/web/CLAUDE.md"]);
    expect(skipped).toEqual([
      { path: "packages/api/CLAUDE.md", kind: "instruction", reason: "managed_file" },
    ]);
  });

  it("keeps the person's text in a CLAUDE.md the ledger lists when its region is intact", async () => {
    const root = await repo({
      ".pathrule/managed-files.json": ledger(["CLAUDE.md"]),
      "CLAUDE.md": mergeRegionInto(PERSON, CLOUD_BODY),
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(sources.map((s) => [s.path, s.content])).toEqual([["CLAUDE.md", PERSON.trim()]]);
    expect(skipped).toEqual([]);
  });

  it("reads past a ledger it cannot parse, and still checks every file", async () => {
    const root = await repo({
      ".pathrule/managed-files.json": "{not json",
      "CLAUDE.md": PERSON,
      ".claude/rules/pathrule-protocol.md": "# Pathrule Protocol\n",
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual(["CLAUDE.md"]);
    expect(skipped.map((s) => s.reason)).toEqual(["pathrule_written"]);
  });

  it("does not follow an import from inside a region or from a skipped file", async () => {
    const root = await repo({
      "CLAUDE.md": mergeRegionInto(
        "# Acme\n\nSee @docs/mine.md.\n",
        `${CLOUD_BODY}\nSee @docs/cloud.md.\n`,
      ),
      "AGENTS.md": `${ROOT_BANNER}\n\nSee @docs/banner.md.\n`,
      "docs/mine.md": "# Mine\n",
      "docs/cloud.md": "# Cloud\n",
      "docs/banner.md": "# Banner\n",
    });
    const sources = await discoverKnowledgeSources(root);
    const kindOf = (p: string) => sources.find((s) => s.path === p)?.kind;
    expect(kindOf("docs/mine.md")).toBe("import-target");
    expect(kindOf("docs/cloud.md")).toBe("document");
    expect(kindOf("docs/banner.md")).toBe("document");
  });

  it("reports an imported file Pathrule wrote as the import target it would have been", async () => {
    const root = await repo({
      "CLAUDE.md": "# Acme\n\nSee @.claude/rules/pathrule-knowledge.md and @notes/cloud.md.\n",
      ".claude/rules/pathrule-knowledge.md": "# Workspace knowledge (Pathrule)\n",
      "notes/cloud.md": `${CLIENT_BANNER}\n# Cloud\n`,
    });
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(paths(sources)).toEqual(["CLAUDE.md"]);
    expect(skipped).toEqual([
      {
        path: ".claude/rules/pathrule-knowledge.md",
        kind: "import-target",
        reason: "pathrule_written",
      },
      { path: "notes/cloud.md", kind: "import-target", reason: "pathrule_banner" },
    ]);
  });

  it("still imports the person's files unchanged", async () => {
    const files = {
      "CLAUDE.md": PERSON,
      "packages/api/AGENTS.md": "## Errors\n\nWrap every handler error in ApiError.\n",
      ".cursorrules": "Always write TypeScript strict mode.\n",
      ".claude/rules/testing.md": "# Testing\n\nVitest only.\n",
      "docs/adr/001-db.md": "# ADR 001\n\n## Rationale\nNever use Mongo for billing.\n",
    };
    const root = await repo(files);
    const { sources, skipped } = await inventoryKnowledgeSources(root);
    expect(Object.fromEntries(sources.map((s) => [s.path, s.content]))).toEqual(files);
    expect(skipped).toEqual([]);
  });

  it("never changes a file on disk", async () => {
    const files = {
      ".pathrule/managed-files.json": ledger(["AGENTS.md"]),
      "CLAUDE.md": mergeRegionInto(PERSON, CLOUD_BODY),
      "AGENTS.md": `${PERSON}${PATHRULE_REGION.end}\n`,
      ".cursor/rules/pathrule-protocol.mdc": CLOUD_BODY,
      ".github/copilot-instructions.md": CLOUD_BODY,
    };
    const root = await repo(files);
    const before = await Promise.all(
      Object.keys(files).map(async (rel) => (await stat(join(root, rel))).mtimeMs),
    );

    await inventoryKnowledgeSources(root);

    for (const [rel, body] of Object.entries(files)) {
      expect(await readFile(join(root, rel), "utf8")).toBe(body);
    }
    const after = await Promise.all(
      Object.keys(files).map(async (rel) => (await stat(join(root, rel))).mtimeMs),
    );
    expect(after).toEqual(before);
  });
});
