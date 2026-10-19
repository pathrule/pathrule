// SPDX-License-Identifier: Apache-2.0
// Native Knowledge Compilation — end-to-end render test: compiled knowledge
// nodes flow through every client renderer into the right native files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompiledKnowledgeNode } from "@pathrule/core";
import {
  __resetHookCommandForTests,
  setHookCommand,
} from "../hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());
import { claudeKnowledgeRenderer } from "./claude-knowledge-renderer.js";
import { codexRenderer } from "./codex-renderer.js";
import { copilotRenderer } from "./copilot-renderer.js";
import { cursorRenderer } from "./cursor-renderer.js";
import { windsurfRenderer } from "./windsurf-renderer.js";
import { TEAM_CONTEXT_HEADING } from "./team-context-block.js";
import type { MultiClientInput } from "./types.js";

const KNOWLEDGE: CompiledKnowledgeNode[] = [
  {
    dir_path: "/",
    markdown: "> Authoritative...\n\n## Rules (must follow)\n\n### Conventional commits\nSign off.\n",
    memory_ids: [],
    rule_ids: ["r-root"],
    skill_ids: [],
    truncated: false,
  },
  {
    dir_path: "/lib",
    markdown:
      "> Authoritative...\n\n## Knowledge & decisions\n\n### Encapsulation model\nPlugins create a new context.\n",
    memory_ids: ["m-lib"],
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
      { node_id: "n2", relative_path: "/lib/route.js", memories: [], rules: [], skills: [] },
    ],
    knowledge: KNOWLEDGE,
  };
}

const byPath = (files: { path: string; body: string }[]) =>
  Object.fromEntries(files.map((f) => [f.path, f.body]));

describe("native knowledge compilation across client renderers", () => {
  it("claude: root knowledge → .claude/rules, subdir knowledge → a path-scoped rule in Pathrule's folder", () => {
    const files = byPath(claudeKnowledgeRenderer.render(input()));
    expect(files[".claude/rules/pathrule-knowledge.md"]).toContain("Conventional commits");
    expect(files[".claude/rules/pathrule/lib.md"]).toContain("Encapsulation model");
    expect(files[".claude/rules/pathrule/lib.md"]).toContain('paths:\n  - "lib/**"');
    expect(files[".claude/rules/pathrule/lib.md"]).toContain("Pathrule managed (knowledge)");
    // never touches a CLAUDE.md the person owns, at the root or in a directory
    expect(files["CLAUDE.md"]).toBeUndefined();
    expect(files["lib/CLAUDE.md"]).toBeUndefined();
  });

  it("codex: root knowledge rides AGENTS.md, subdir gets nested AGENTS.md", () => {
    const files = byPath(codexRenderer.render(input()));
    expect(files["AGENTS.md"]).toContain("Workspace knowledge (Pathrule)");
    expect(files["AGENTS.md"]).toContain("Conventional commits");
    expect(files["lib/AGENTS.md"]).toContain("Encapsulation model");
  });

  it("cursor: subdir knowledge is a glob-scoped .mdc rule", () => {
    const files = byPath(cursorRenderer.render(input()));
    const mdc = files[".cursor/rules/pathrule-k-lib.mdc"];
    expect(mdc).toContain('globs: "lib/**"');
    expect(mdc).toContain("Encapsulation model");
    expect(files[".cursor/rules/pathrule-protocol.mdc"]).toContain("Conventional commits");
  });

  it("copilot: subdir knowledge is an applyTo-scoped instructions file", () => {
    const files = byPath(copilotRenderer.render(input()));
    const scoped = files[".github/instructions/pathrule-k-lib.instructions.md"];
    expect(scoped).toContain('applyTo: "lib/**"');
    expect(scoped).toContain("Encapsulation model");
  });

  it("windsurf: subdir knowledge lands under .windsurf/rules with a path heading", () => {
    const files = byPath(windsurfRenderer.render(input()));
    const rule = files[".windsurf/rules/pathrule-k-lib.md"];
    expect(rule).toContain("applies to /lib");
    expect(rule).toContain("Encapsulation model");
  });

  it("ownedPaths cover overview directories so removed knowledge gets swept", () => {
    const owned = claudeKnowledgeRenderer.ownedPaths(input());
    expect(owned).toContain("lib/CLAUDE.md");
    // file node folds up — no owned path for lib/route.js
    expect(owned.some((p) => p.includes("route.js"))).toBe(false);
  });

  it("team context: every client emits the block exactly once, at the end", () => {
    const withTeam: MultiClientInput = {
      ...input(),
      teamContext: {
        teamName: "Atolye15",
        userName: "Sertan",
        owners: [{ name: "Alperen", area: "/lib" }],
      },
    };
    const targets: Array<[string, (i: MultiClientInput) => { path: string; body: string }[]]> = [
      [".claude/rules/pathrule-knowledge.md", (i) => claudeKnowledgeRenderer.render(i)],
      ["AGENTS.md", (i) => codexRenderer.render(i)],
      [".cursor/rules/pathrule-protocol.mdc", (i) => cursorRenderer.render(i)],
      [".github/copilot-instructions.md", (i) => copilotRenderer.render(i)],
      [".windsurf/rules/pathrule-protocol.md", (i) => windsurfRenderer.render(i)],
    ];
    for (const [path, render] of targets) {
      const body = byPath(render(withTeam))[path];
      expect(body, `${path} should exist`).toBeDefined();
      expect(body!.split(TEAM_CONTEXT_HEADING).length - 1, `${path} block count`).toBe(1);
      // Last section in the file: nothing but the block after its heading.
      const tail = body!.slice(body!.indexOf(TEAM_CONTEXT_HEADING) + TEAM_CONTEXT_HEADING.length);
      expect(tail).toContain("Alperen (/lib)");
      // Nothing follows the block: it is the last section in the file.
      expect(tail.includes("\n## ")).toBe(false);
    }
  });

  it("team context: the knowledge prefix stays byte-identical (prompt cache gate)", () => {
    const bare = input();
    const withTeam: MultiClientInput = {
      ...bare,
      teamContext: { teamName: "Atolye15", userName: "Sertan" },
    };
    const paths = [
      [".claude/rules/pathrule-knowledge.md", claudeKnowledgeRenderer],
      ["AGENTS.md", codexRenderer],
      [".cursor/rules/pathrule-protocol.mdc", cursorRenderer],
      [".github/copilot-instructions.md", copilotRenderer],
      [".windsurf/rules/pathrule-protocol.md", windsurfRenderer],
    ] as const;
    for (const [path, renderer] of paths) {
      const before = byPath(renderer.render(bare))[path];
      const after = byPath(renderer.render(withTeam))[path];
      const cut = after!.indexOf(TEAM_CONTEXT_HEADING);
      expect(cut, `${path} should carry the block`).toBeGreaterThan(0);
      // Everything the client already had is unchanged, byte for byte.
      expect(after!.slice(0, cut).trimEnd()).toBe(before!.trimEnd());
    }
  });

  it("team context: claude gets the file even with no compiled root knowledge", () => {
    const files = byPath(
      claudeKnowledgeRenderer.render({
        ...input(),
        knowledge: undefined,
        teamContext: { teamName: "Atolye15", userName: "Sertan" },
      }),
    );
    const body = files[".claude/rules/pathrule-knowledge.md"];
    expect(body).toContain("Pathrule managed (knowledge)");
    expect(body).toContain("Team: Atolye15. User: Sertan.");
  });

  it("without knowledge, renderers emit no knowledge files (legacy behavior)", () => {
    const bare = { ...input(), knowledge: undefined };
    expect(claudeKnowledgeRenderer.render(bare)).toHaveLength(0);
    const cursorFiles = byPath(cursorRenderer.render(bare));
    expect(Object.keys(cursorFiles).some((p) => p.includes("pathrule-k-"))).toBe(false);
  });
});
