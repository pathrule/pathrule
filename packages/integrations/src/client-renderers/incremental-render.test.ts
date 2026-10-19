// SPDX-License-Identifier: Apache-2.0
// Incremental re-render correctness guard. Editing one item must
// re-render only that item's directory file (byte-identical to a full render)
// and, with the sweep disabled, must touch/remove nothing else.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledKnowledgeNode } from "@pathrule/core";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

import { scopeToEntity } from "./pipeline.js";
import { claudeKnowledgeRenderer } from "./claude-knowledge-renderer.js";
import { writeMultiClientFiles } from "./disk-writer.js";
import type { ClientRenderResult } from "./orchestrator.js";
import type { MultiClientInput } from "./types.js";

const KNOWLEDGE: CompiledKnowledgeNode[] = [
  {
    dir_path: "/",
    markdown: "> Authoritative...\n\n### Root rule\nSign off.\n",
    memory_ids: [],
    rule_ids: ["r-root"],
    skill_ids: [],
    truncated: false,
  },
  {
    dir_path: "/lib",
    markdown: "> Authoritative...\n\n### Encapsulation\nPlugins create a new context.\n",
    memory_ids: ["m-lib"],
    rule_ids: [],
    skill_ids: [],
    truncated: false,
  },
  {
    dir_path: "/api",
    markdown: "> Authoritative...\n\n### Auth\nVerify the JWT.\n",
    memory_ids: ["m-api"],
    rule_ids: [],
    skill_ids: [],
    truncated: false,
  },
];

function input(): MultiClientInput {
  return {
    workspaceName: "demo",
    overview: [
      { node_id: "n1", relative_path: "/lib", memories: [], rules: [], skills: [] },
      { node_id: "n2", relative_path: "/api", memories: [], rules: [], skills: [] },
    ],
    knowledge: KNOWLEDGE,
  };
}

const byPath = (files: { path: string; body: string }[]) =>
  Object.fromEntries(files.map((f) => [f.path, f.body]));

describe("scopeToEntity", () => {
  it("returns the input untouched + sweep when there is no entity", () => {
    const r = scopeToEntity(input(), undefined);
    expect(r.sweep).toBe(true);
    expect(r.input.knowledge).toHaveLength(3);
  });

  it("scopes to the changed entity's dir + root, and disables the sweep", () => {
    const r = scopeToEntity(input(), { kind: "memory", id: "m-lib" });
    expect(r.sweep).toBe(false);
    const dirs = (r.input.knowledge ?? []).map((n) => n.dir_path).sort();
    expect(dirs).toEqual(["/", "/lib"]); // root always kept; /api excluded
  });

  it("falls back to a full sweeping render when the entity matches no node", () => {
    const r = scopeToEntity(input(), { kind: "memory", id: "does-not-exist" });
    expect(r.sweep).toBe(true);
    expect(r.input.knowledge).toHaveLength(3);
  });

  it("the scoped file is byte-identical to the full render for the changed dir", () => {
    const full = byPath(claudeKnowledgeRenderer.render(input()));
    const scoped = byPath(
      claudeKnowledgeRenderer.render(scopeToEntity(input(), { kind: "memory", id: "m-lib" }).input),
    );
    // The changed dir's file matches exactly...
    expect(scoped[".claude/rules/pathrule/lib.md"]).toBe(full[".claude/rules/pathrule/lib.md"]);
    // ...and the unrelated dir's file is simply not emitted by the scoped render.
    expect(scoped[".claude/rules/pathrule/api.md"]).toBeUndefined();
    expect(full[".claude/rules/pathrule/api.md"]).toContain("Auth");
  });
});

describe("writeMultiClientFiles sweep toggle", () => {
  const tmps: string[] = [];
  afterAll(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
  });
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "pathrule-sweep-"));
    tmps.push(d);
    return d;
  }

  // A render result that owns api/CLAUDE.md but only emits lib/CLAUDE.md this run.
  function partialResult(): ClientRenderResult {
    return {
      client: "claude-code",
      files: [{ path: "lib/CLAUDE.md", body: "<!-- Pathrule managed (knowledge) -->\nlib\n" }],
      ownedPaths: ["lib/CLAUDE.md", "api/CLAUDE.md"],
    };
  }

  function seedOrphan(root: string): string {
    const orphan = join(root, "api", "CLAUDE.md");
    mkdirSync(join(root, "api"), { recursive: true });
    writeFileSync(orphan, "<!-- Pathrule managed (knowledge) -->\nstale api\n", "utf8");
    return orphan;
  }

  it("sweep:false leaves the orphaned owned file untouched", async () => {
    const root = freshDir();
    const orphan = seedOrphan(root);
    const res = await writeMultiClientFiles({
      workspaceRoot: root,
      results: [partialResult()],
      sweepFor: ["claude-code"],
      sweep: false,
    });
    expect(res.removed).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(root, "lib", "CLAUDE.md"))).toBe(true);
  });

  it("default (sweep on) removes the orphaned Pathrule-managed file", async () => {
    const root = freshDir();
    const orphan = seedOrphan(root);
    const res = await writeMultiClientFiles({
      workspaceRoot: root,
      results: [partialResult()],
      sweepFor: ["claude-code"],
    });
    expect(res.removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });
});
