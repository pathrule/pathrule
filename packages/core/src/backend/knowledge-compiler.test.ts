// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleKnowledgeNodes } from "./knowledge-compiler.js";
import type { HookIndexInput } from "./hook-index.js";

function input(overrides?: Partial<HookIndexInput>): HookIndexInput {
  return {
    workspaceId: "ws",
    generatedAt: "2026-06-10T00:00:00.000Z",
    memories: [],
    rules: [],
    skills: [],
    recentActivitySubjects: [],
    recentActivityDigest: [],
    workEpisodes: [],
    pendingRefreshCount: 0,
    inProgressRefreshCount: 0,
    ...overrides,
  };
}

describe("assembleKnowledgeNodes (native compilation core)", () => {
  it("groups full bodies per directory, rules before memories, high priority first", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        memories: [
          { id: "m1", title: "Encapsulation model", content: "Plugins create a new context.", node_path: "/lib" },
        ],
        rules: [
          { id: "r2", name: "Low rule", content: "minor", scope_type: "folder", priority: "low", node_paths: ["/lib"] },
          { id: "r1", name: "No shared state", content: "Never store mutable module state.", scope_type: "folder", priority: "high", node_paths: ["/lib"] },
        ],
      }),
    );
    expect(nodes).toHaveLength(1);
    const lib = nodes[0]!;
    expect(lib.dir_path).toBe("/lib");
    expect(lib.markdown).toContain("Authoritative");
    const iRules = lib.markdown.indexOf("## Rules");
    const iHigh = lib.markdown.indexOf("No shared state");
    const iLow = lib.markdown.indexOf("Low rule");
    const iMem = lib.markdown.indexOf("Encapsulation model");
    expect(iRules).toBeGreaterThan(-1);
    expect(iHigh).toBeLessThan(iLow); // high before low
    expect(iLow).toBeLessThan(iMem); // rules before memories
    expect(lib.markdown).toContain("Plugins create a new context."); // FULL body
    expect(lib.rule_ids).toEqual(["r1", "r2"]);
    expect(lib.memory_ids).toEqual(["m1"]);
  });

  it("folds file-level knowledge into the parent directory with a leaf marker", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        memories: [
          { id: "m1", title: "Route registration", content: "Compiled once at boot.", node_path: "/lib/route.js" },
        ],
        rules: [
          { id: "r1", name: "No route changes after ready()", content: "Router is compiled once.", scope_type: "file_type", priority: "high", node_paths: ["/lib/route.js"] },
        ],
      }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.dir_path).toBe("/lib");
    expect(nodes[0]!.markdown).toContain("Route registration (route.js)");
    expect(nodes[0]!.markdown).toContain("No route changes after ready() (route.js)");
  });

  it("routes project-scoped rules to the root node", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        rules: [
          { id: "r1", name: "Conventional commits", content: "Sign off every commit.", scope_type: "project", priority: "medium", node_paths: [] },
        ],
      }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.dir_path).toBe("/");
    expect(nodes[0]!.markdown).toContain("Conventional commits");
  });

  it("is deterministic (same input, same bytes)", () => {
    const make = () =>
      assembleKnowledgeNodes(
        input({
          memories: [
            { id: "m2", title: "B", content: "b", node_path: "/lib" },
            { id: "m1", title: "A", content: "a", node_path: "/lib" },
          ],
        }),
      )[0]!.markdown;
    expect(make()).toBe(make());
  });

  it("compiles skills in full at their attached path (procedures section)", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        skills: [
          {
            id: "s1",
            name: "write-route-test",
            description: "checklist",
            content: "1. fresh instance\n2. inject()\n3. t.after teardown",
            source: "manual",
            github_url: null,
            node_paths: ["/test"],
          },
        ],
      }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.dir_path).toBe("/test");
    expect(nodes[0]!.markdown).toContain("## Procedures (follow step by step)");
    expect(nodes[0]!.markdown).toContain("t.after teardown"); // full body
    expect(nodes[0]!.skill_ids).toEqual(["s1"]);
  });

  it("routes unattached skills to the root node", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        skills: [
          { id: "s1", name: "deploy", description: null, content: "steps", source: "manual", github_url: null },
        ],
      }),
    );
    expect(nodes[0]!.dir_path).toBe("/");
    expect(nodes[0]!.skill_ids).toEqual(["s1"]);
  });

  it("SLIM mode: memory/skill become a title index (no body); rules stay full", () => {
    const nodes = assembleKnowledgeNodes(
      input({
        memories: [
          { id: "m1", title: "Encapsulation model", content: "Plugins create a new context.", node_path: "/lib" },
        ],
        rules: [
          { id: "r1", name: "No shared state", content: "Never store mutable module state.", scope_type: "folder", priority: "high", node_paths: ["/lib"] },
        ],
        skills: [
          { id: "s1", name: "write-route-test", description: null, content: "1. fresh instance\n2. inject()", source: "manual", github_url: null, node_paths: ["/lib"] },
        ],
      }),
      { mode: "slim" },
    );
    const lib = nodes[0]!;
    // Rule body present (floored), memory/skill bodies absent.
    expect(lib.markdown).toContain("Never store mutable module state."); // rule full
    expect(lib.markdown).toContain("- Encapsulation model"); // memory title only
    expect(lib.markdown).not.toContain("Plugins create a new context."); // NO body
    expect(lib.markdown).toContain("- write-route-test"); // skill name only
    expect(lib.markdown).not.toContain("fresh instance"); // NO skill body
    // Id split: bodies-in-file vs title-indexed.
    expect(lib.rule_ids).toEqual(["r1"]);
    expect(lib.memory_ids).toEqual([]); // no bodies → nothing for compiled_memory_ids to mask
    expect(lib.skill_ids).toEqual([]);
    expect(lib.indexed_memory_ids).toEqual(["m1"]);
    expect(lib.indexed_skill_ids).toEqual(["s1"]);
  });

  it("SLIM mode keeps a 20-memory path tiny (title index, not 20 bodies)", () => {
    const big = "y".repeat(1000);
    const memories = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      title: `Memory number ${i}`,
      content: big,
      node_path: "/lib",
    }));
    const nodes = assembleKnowledgeNodes(input({ memories }), { mode: "slim" });
    const lib = nodes[0]!;
    expect(lib.indexed_memory_ids).toHaveLength(20); // all titles indexed
    expect(lib.markdown).not.toContain(big); // not a single body in the file
    expect(lib.truncated).toBe(false); // titles fit easily
    expect(lib.markdown.length).toBeLessThan(2000); // tiny vs ~20KB of bodies
  });

  it("FULL mode is the default and unchanged (regression guard)", () => {
    const args = input({
      memories: [{ id: "m1", title: "A", content: "body-a", node_path: "/lib" }],
    });
    const def = assembleKnowledgeNodes(args)[0]!;
    const full = assembleKnowledgeNodes(args, { mode: "full" })[0]!;
    expect(def.markdown).toBe(full.markdown);
    expect(def.markdown).toContain("body-a"); // full body present by default
    expect(def.memory_ids).toEqual(["m1"]);
  });

  it("enforces the per-directory budget and flags truncation without silent loss", () => {
    const big = "x".repeat(7000);
    const nodes = assembleKnowledgeNodes(
      input({
        memories: [
          { id: "m1", title: "First", content: big, node_path: "/lib" },
          { id: "m2", title: "Second", content: big, node_path: "/lib" },
        ],
      }),
    );
    const lib = nodes[0]!;
    expect(lib.memory_ids).toEqual(["m1"]); // second didn't fit the 12K budget
    expect(lib.truncated).toBe(true);
    expect(lib.markdown).toContain("omitted for size");
  });
});
