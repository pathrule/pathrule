// SPDX-License-Identifier: Apache-2.0
// Signature mode writes ONE folder for Claude: the binding knowledge as path-scoped rules
// (.claude/rules/pathrule/*.md with `paths:`), which Claude loads as instructions when work enters the
// area. The folder ignores itself; the user's .gitignore is never edited.
import { describe, expect, it } from "vitest";
import { claudeKnowledgeRenderer } from "./claude-knowledge-renderer.js";
import type { MultiClientInput } from "./types.js";

const node = (dir_path: string, memory_ids: string[], markdown: string) => ({ dir_path, markdown, memory_ids, rule_ids: [], skill_ids: [], truncated: false });
const input = (knowledgeBinding?: MultiClientInput["knowledgeBinding"]): MultiClientInput => ({
  workspaceName: "w", overview: [], companionMode: "signature", knowledgeBinding,
});

describe("Claude binding rules in signature mode", () => {
  it("writes one path-scoped file per area, an unscoped root file, and a self-ignoring folder", () => {
    const files = claudeKnowledgeRenderer.render(input([node("/", ["r"], "ROOT_RULE\n"), node("/apps/api", ["a"], "API_RULE\n")]));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.body]));
    expect(byPath[".claude/rules/pathrule/apps-api.md"]).toMatch(/^---\npaths:\n {2}- "apps\/api\/\*\*"\n---\n/);
    expect(byPath[".claude/rules/pathrule/apps-api.md"]).toContain("API_RULE");
    expect(byPath[".claude/rules/pathrule/workspace.md"]).not.toContain("paths:");
    expect(byPath[".claude/rules/pathrule/workspace.md"]).toContain("ROOT_RULE");
    expect(byPath[".claude/rules/pathrule/.gitignore"]).toContain("*");
    expect(claudeKnowledgeRenderer.ownedPaths(input([node("/apps/api", ["a"], "x\n")]))).toContain(".claude/rules/pathrule/apps-api.md");
  });

  it("records which memory versions the files hold, for the hook to skip only those", () => {
    const files = claudeKnowledgeRenderer.render(input([
      { ...node("/", ["m1"], "M1\n"), memory_hashes: { m1: "h1" } },
      { ...node("/apps/api", ["m2"], "M2\n"), memory_hashes: { m2: "h2" } },
    ]));
    const manifest = files.find((f) => f.path === ".claude/rules/pathrule/manifest.json");
    expect(JSON.parse(manifest!.body).memories).toEqual({ m1: "h1", m2: "h2" });
    expect(JSON.parse(manifest!.body).root).toEqual(["m1"]);
    expect(claudeKnowledgeRenderer.ownedPaths(input([node("/", ["m1"], "x\n")]))).toContain(".claude/rules/pathrule/manifest.json");
  });

  it("asks the agent, at session start, to keep the knowledge current, with or without knowledge yet", () => {
    for (const k of [undefined, [], [node("/", ["r"], "ROOT_RULE\n")]]) {
      const files = claudeKnowledgeRenderer.render(input(k));
      const root = files.find((f) => f.path === ".claude/rules/pathrule/workspace.md")!.body;
      expect(root).toContain("## Keep this knowledge current");
      expect(root).toContain("pathrule_remember_preference");
      expect(root).not.toContain("paths:");
      expect(files.map((f) => f.path)).toContain(".claude/rules/pathrule/.gitignore");
    }
  });
});
