// SPDX-License-Identifier: Apache-2.0
// Onboarding scenario matrix — what Pathrule actually does to each KIND of
// repo a user can bring.
//
// The five scenarios below are the real population: an empty project, a thin
// CLAUDE.md next to big planning docs, a deeply @imported instruction tree, a
// Cursor-first repo, and a repo already running a vector RAG store.
//
// Each scenario measures two things and asserts the CURRENT numbers:
//   1. CAPTURE — how much of the folder's knowledge Pathrule actually ingests
//      (importClaudeMd), and how much of it is garbage.
//   2. DISK    — what happens to the user's files (writeMultiClientFiles).
//
// The assertions are deliberately exact. When we fix a gap, the number moves
// and the test fails, which is the only honest way to prove a fix landed.
// A scenario whose current numbers are bad says so in its `it` name.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledKnowledgeNode } from "@pathrule/core";

import { __resetHookCommandForTests, setHookCommand } from "./hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/tmp/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

import { importClaudeMd, importDiscoveredSources } from "@pathrule/core/knowledge-import/drafts.js";
import { discoverKnowledgeSources } from "@pathrule/core/knowledge-import/discovery.js";
import { renderForClients } from "./client-renderers/orchestrator.js";
import { writeMultiClientFiles } from "./client-renderers/disk-writer.js";
import type { MultiClientInput } from "./client-renderers/types.js";

// ─── Scenario fixtures ───────────────────────────────────────────────────────

interface Scenario {
  name: string;
  /** Files to lay down, relative path → content. */
  files: Record<string, string>;
  /** Directories Pathrule has knowledge for (drives the overview + knowledge). */
  knowledgeDirs: string[];
}

const SCENARIOS: Record<"A" | "B" | "C" | "D" | "E", Scenario> = {
  // A — brand new project. Nothing to lose.
  A: { name: "empty project", files: {}, knowledgeDirs: ["/src"] },

  // B — thin CLAUDE.md, but the real knowledge lives in planning docs.
  B: {
    name: "thin CLAUDE.md, rich planning docs",
    files: {
      "CLAUDE.md": "# Acme\n\nRun pnpm dev.\n",
      "docs/adr/001-database.md":
        "# ADR 001: Postgres over Mongo\n\n## Decision\nPostgres.\n\n## Rationale\nWe need transactions across billing rows.\n",
      "docs/plans/q3-roadmap.md":
        "# Q3 Roadmap\n\n- [x] Ship billing\n- [ ] Ship SSO\n",
      "docs/architecture.md": "# Architecture\n\nMonolith with a worker queue.\n",
    },
    knowledgeDirs: ["/src"],
  },

  // C — the deeply linked tree. Imports, nested files, custom rules.
  C: {
    name: "deeply @imported instruction tree",
    files: {
      "CLAUDE.md":
        "# Acme Platform\n\nSee @docs/architecture.md and @.claude/conventions/api.md.\n\n## Setup\n\n```bash\n# Install dependencies first\npnpm install\n```\n\n## Conventions\nUse camelCase.\n",
      "docs/architecture.md": "# Architecture\n\nService map lives here.\n",
      ".claude/conventions/api.md": "# API conventions\n\nAlways version endpoints.\n",
      ".claude/rules/testing.md": "# Testing\n\nVitest only. No jest.\n",
      "packages/api/CLAUDE.md": "# API package\n\nNode 20 only. Never import packages/web.\n",
      "packages/web/CLAUDE.md": "# Web package\n\nReact 19. No class components.\n",
    },
    knowledgeDirs: ["/packages/api", "/packages/web"],
  },

  // D — a Cursor-first repo. No CLAUDE.md at all.
  D: {
    name: "Cursor-first repo",
    files: {
      ".cursorrules": "Always write TypeScript strict mode.\n",
      ".cursor/rules/backend.mdc":
        '---\nglobs: "services/api/**"\n---\n# Backend\n\nUse the repository pattern.\n',
      ".cursor/rules/style.mdc":
        "---\nalwaysApply: true\n---\n# Style\n\nTwo-space indent.\n",
    },
    knowledgeDirs: ["/services/api"],
  },

  // E — a repo already running a vector RAG store over its own docs.
  E: {
    name: "existing vector RAG store",
    files: {
      "CLAUDE.md": "# Acme\n\nKnowledge is in the vector store, ask the retriever.\n",
      "rag/chroma/chroma.sqlite3": "binary-ish placeholder\n",
      "rag/ingest.py": "# chunk and embed docs/\n",
      "docs/runbook.md": "# Runbook\n\nRestart the worker with pnpm worker:restart.\n",
    },
    knowledgeDirs: ["/rag"],
  },
};

function knowledgeFor(dirs: string[]): CompiledKnowledgeNode[] {
  return [
    {
      dir_path: "/",
      markdown: "> Authoritative...\n\n## Rules (must follow)\n\n### Root rule\nDo the thing.\n",
      memory_ids: [],
      rule_ids: ["r-root"],
      skill_ids: [],
      truncated: false,
    },
    ...dirs.map((d) => ({
      dir_path: d,
      markdown: `> Authoritative...\n\n## Rules (must follow)\n\n### Rule for ${d}\nObey.\n`,
      memory_ids: [],
      rule_ids: [`r-${d}`],
      skill_ids: [],
      truncated: false,
    })),
  ];
}

function inputFor(s: Scenario): MultiClientInput {
  const knowledge = knowledgeFor(s.knowledgeDirs);
  return {
    workspaceName: "acme",
    overview: s.knowledgeDirs.map((d, i) => ({
      node_id: `n${i}`,
      relative_path: d,
      memories: [],
      rules: [],
      skills: [],
    })),
    knowledge,
    knowledgeSlim: knowledge,
  };
}

async function layDown(s: Scenario): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pathrule-scenario-"));
  for (const [rel, body] of Object.entries(s.files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
  return root;
}

const CLIENTS = ["claude-code", "codex", "cursor"] as const;

async function syncScenario(s: Scenario) {
  const root = await layDown(s);
  const results = renderForClients(inputFor(s), [...CLIENTS]);
  const disk = await writeMultiClientFiles({
    workspaceRoot: root,
    results,
    sweepFor: [...CLIENTS],
    runtimeOwner: "desktop",
    runtimeVersion: "1.0.0",
  });
  return { root, disk };
}

/** Did the user's original content survive INSIDE the live file at `rel`? */
async function liveStillHas(root: string, rel: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(join(root, rel), "utf8")).includes(needle);
  } catch {
    return false;
  }
}

/** @-import targets referenced by a body, excluding fenced/inline code. */
function importTargets(body: string): string[] {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return [...withoutFences.matchAll(/(?:^|\s)@([./\w-]+\.md)/g)].map((m) => m[1]!);
}

// ─── CAPTURE: how much of the folder do we actually ingest ───────────────────

describe("CAPTURE: what Pathrule ingests from each repo kind", () => {
  it("A/empty: nothing to import, so nothing is lost", () => {
    expect(importClaudeMd("")).toEqual([]);
  });

  it("B: the ADR's decision and rationale are ingested; the roadmap is not", async () => {
    const root = await layDown(SCENARIOS.B);
    const drafts = importDiscoveredSources(await discoverKnowledgeSources(root));
    const ingested = JSON.stringify(drafts);

    // The decision that used to be invisible now lands in Pathrule.
    expect(ingested).toContain("Postgres");
    expect(ingested).toContain("transactions across billing rows");
    // The thin CLAUDE.md is still imported.
    expect(ingested).toContain("Run pnpm dev");
    // A roadmap is derivable and goes stale, so it is offered rather than
    // imported: its checkbox list must not become a memory.
    expect(ingested).not.toContain("Ship SSO");
  });

  it("C: code fences stay intact; the @import chain is still not followed", () => {
    const root = SCENARIOS.C.files["CLAUDE.md"]!;
    const drafts = importClaudeMd(root);

    // Shell comments inside a ```bash fence are no longer mistaken for headings.
    const titles = drafts.map((d) => d.title);
    expect(titles).toEqual(["Acme Platform", "Setup", "Conventions"]);
    expect(titles).not.toContain("Install dependencies first");
    const setup = drafts.find((d) => d.title === "Setup")!;
    expect(setup.content).toContain("pnpm install");
    expect((setup.content.match(/```/g) ?? []).length).toBe(2); // fence not split

    // REMAINING GAP: the import targets are real files on disk...
    expect(importTargets(root)).toEqual(["docs/architecture.md", ".claude/conventions/api.md"]);
    // ...but none of their CONTENT is ingested. The files themselves are no
    // longer orphaned (the root CLAUDE.md keeps its @import lines now), so the
    // agent still reads them; they are simply not mirrored into Pathrule.
    const ingested = JSON.stringify(drafts);
    expect(ingested).not.toContain("Service map lives here");
    expect(ingested).not.toContain("Always version endpoints");
  });

  it("D: a Cursor-first repo's rules are ingested even with no CLAUDE.md", async () => {
    const root = await layDown(SCENARIOS.D);
    const drafts = importDiscoveredSources(await discoverKnowledgeSources(root));
    const ingested = JSON.stringify(drafts);

    // Both the legacy single file and the modern glob-scoped rules.
    expect(ingested).toContain("TypeScript strict mode");
    expect(ingested).toContain("repository pattern");
    expect(ingested).toContain("Two-space indent");
    expect(drafts.length).toBeGreaterThan(0);
  });

  it("C: the @import chain's content is ingested too", async () => {
    const root = await layDown(SCENARIOS.C);
    const drafts = importDiscoveredSources(await discoverKnowledgeSources(root));
    const ingested = JSON.stringify(drafts);

    // Previously the import TARGETS were never read, so these strings could not
    // reach Pathrule however the user wrote them.
    expect(ingested).toContain("Service map lives here");
    expect(ingested).toContain("Always version endpoints");
    // Nested instruction files are attributed to their own package.
    expect(drafts.some((d) => d.nodePath === "/packages/api")).toBe(true);
    expect(drafts.some((d) => d.nodePath === "/packages/web")).toBe(true);
  });

  it("E: a RAG repo's runbook is ingested; the vector store is left alone", async () => {
    const root = await layDown(SCENARIOS.E);
    const sources = await discoverKnowledgeSources(root);

    // The runbook is a document, so it is offered rather than auto-imported...
    expect(sources.some((s) => s.path === "docs/runbook.md" && s.kind === "document")).toBe(true);
    // ...and the vector store itself is never treated as knowledge.
    expect(sources.some((s) => s.path.startsWith("rag/"))).toBe(false);
  });
});

// ─── DISK: what happens to the user's files ──────────────────────────────────

describe("DISK: what sync does to each repo kind", () => {
  it("A/empty: writes cleanly, backs nothing up", async () => {
    const { disk } = await syncScenario(SCENARIOS.A);
    expect(disk.backedUp).toEqual([]);
    expect(disk.errors).toEqual([]);
    expect(disk.written).toBeGreaterThan(0);
  });

  it("B/thin: the user's thin CLAUDE.md is untouched by the multi-client path", async () => {
    const { root, disk } = await syncScenario(SCENARIOS.B);
    expect(await liveStillHas(root, "CLAUDE.md", "Run pnpm dev")).toBe(true);
    // AGENTS.md did not exist, so Pathrule creates it without backing anything up.
    expect(disk.backedUp).toEqual([]);
  });

  it("C: nested instruction files keep the user's rules, and Pathrule's knowledge lives in its own file", async () => {
    const { root, disk } = await syncScenario(SCENARIOS.C);

    // Nothing is moved aside at all.
    expect(disk.backedUp).toEqual([]);

    // The person's nested file keeps their rule and gains nothing; the area's knowledge is a
    // path-scoped rule in Pathrule's own folder.
    expect(await liveStillHas(root, "packages/api/CLAUDE.md", "Never import packages/web")).toBe(
      true,
    );
    expect(await liveStillHas(root, "packages/api/CLAUDE.md", "Rule for /packages/api")).toBe(false);
    expect(await liveStillHas(root, ".claude/rules/pathrule/packages-api.md", "Rule for /packages/api")).toBe(true);
    expect(await liveStillHas(root, "packages/web/CLAUDE.md", "No class components")).toBe(true);

    // The root file keeps its @import chain intact, which a takeover severed.
    expect(await liveStillHas(root, "CLAUDE.md", "@docs/architecture.md")).toBe(true);
    expect(await liveStillHas(root, "CLAUDE.md", "Use camelCase.")).toBe(true);

    // The user's own .claude/rules file is left alone (Pathrule-invented names only).
    expect(await liveStillHas(root, ".claude/rules/testing.md", "Vitest only")).toBe(true);
  });

  it("D: the Cursor user's .cursorrules keeps its content", async () => {
    const { root, disk } = await syncScenario(SCENARIOS.D);

    expect(disk.backedUp).toEqual([]);
    expect(await liveStillHas(root, ".cursorrules", "TypeScript strict mode")).toBe(true);
    expect(await liveStillHas(root, ".cursorrules", "Pathrule")).toBe(true);

    // The user's own .mdc rules survive: Pathrule uses its own filenames there.
    expect(await liveStillHas(root, ".cursor/rules/backend.mdc", "repository pattern")).toBe(true);
    expect(await liveStillHas(root, ".cursor/rules/style.mdc", "Two-space indent")).toBe(true);
  });

  it("E/rag: the vector store and docs are never touched", async () => {
    const { root } = await syncScenario(SCENARIOS.E);
    expect(await liveStillHas(root, "rag/ingest.py", "chunk and embed")).toBe(true);
    expect(await liveStillHas(root, "docs/runbook.md", "pnpm worker:restart")).toBe(true);
  });

  it("every scenario is idempotent on a second sync", async () => {
    for (const key of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
      const s = SCENARIOS[key];
      const root = await layDown(s);
      const results = renderForClients(inputFor(s), [...CLIENTS]);
      const opts = {
        workspaceRoot: root,
        results,
        sweepFor: [...CLIENTS],
        runtimeOwner: "desktop" as const,
        runtimeVersion: "1.0.0",
      };
      await writeMultiClientFiles(opts);
      const second = await writeMultiClientFiles(opts);
      expect({ key, written: second.written, backedUp: second.backedUp.length }).toEqual({
        key,
        written: 0,
        backedUp: 0,
      });
    }
  });
});
