// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleHookIndex, assembleWarehouse, type HookIndexInput } from "./hook-index.js";

function baseInput(overrides?: Partial<HookIndexInput>): HookIndexInput {
  return {
    workspaceId: "ws-1",
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

describe("assembleHookIndex content_hash (delta primitive)", () => {
  it("stamps content_hash on memory, rule, and skill stubs", () => {
    const index = assembleHookIndex(
      baseInput({
        memories: [
          { id: "m1", title: "Encapsulation", content: "Plugins create a new context.", node_path: "/lib" },
        ],
        rules: [
          {
            id: "r1",
            name: "No raw hex",
            content: "Use design tokens, never raw hex.",
            scope_type: "folder",
            priority: "high",
            node_paths: ["/packages/ui"],
          },
        ],
        skills: [
          { id: "s1", name: "add-plugin", description: null, content: "Step 1...", source: "manual", github_url: null },
        ],
      }),
    );

    const mem = index.path_memories["/lib"]?.[0];
    const rule = index.path_rules["/packages/ui"]?.[0];
    const skill = index.skill_invocation_index?.["add-plugin"]?.[0];

    expect(mem?.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rule?.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(skill?.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for identical content and changes when content changes", () => {
    const make = (content: string) =>
      assembleHookIndex(
        baseInput({
          memories: [{ id: "m1", title: "T", content, node_path: "/lib" }],
        }),
      ).path_memories["/lib"]![0]!.content_hash;

    const a = make("original body");
    const b = make("original body");
    const c = make("edited body");

    expect(a).toBe(b); // unchanged content ⇒ same hash ⇒ no re-injection
    expect(a).not.toBe(c); // edited content ⇒ new hash ⇒ delta re-injects
  });
});

describe("assembleHookIndex hot_paths (routing signal)", () => {
  it("derives top hot paths from recent activity", () => {
    const index = assembleHookIndex(
      baseInput({
        recentActivityDigest: [
          { domain: "backend", action: "update", node_path: "/lib", task_summary: "x" },
          { domain: "backend", action: "fix", node_path: "/lib", task_summary: "y" },
          { domain: "ui", action: "update", node_path: "/web", task_summary: "z" },
          { domain: "docs", action: "update", node_path: "/", task_summary: "root ignored" },
        ],
      }),
    );
    expect(index.hot_paths).toEqual([
      { path: "/lib", count: 2 },
      { path: "/web", count: 1 },
    ]);
  });
});

// The protocol field is the switch AND the payload: a workspace still compiling
// the protocol into its companion files must not get it on the index, or the
// agent reads it twice on the first prompt of every session.
describe("assembleHookIndex protocol delivery", () => {
  it("omits the field by default", () => {
    expect(assembleHookIndex(baseInput({})).protocol).toBeUndefined();
  });

  it("carries the rendered protocol when the caller supplies one", () => {
    const index = assembleHookIndex(baseInput({ protocol: "# Protocol\n\n1. do the thing" }));
    expect(index.protocol).toBe("# Protocol\n\n1. do the thing");
  });

  it("treats a blank protocol as absent", () => {
    expect(assembleHookIndex(baseInput({ protocol: "   \n " })).protocol).toBeUndefined();
  });
});

describe("assembleHookIndex keys written by members", () => {
  it("indexes skills named like Object.prototype members instead of failing the whole index", () => {
    const skill = (id: string, name: string) => ({
      id,
      name,
      description: null,
      content: "Step 1...",
      source: "manual",
      github_url: null,
    });
    const input = baseInput({
      memories: [{ id: "__proto__", title: "Proto id", content: "Body", node_path: "/" }],
      skills: [skill("s1", "constructor"), skill("s2", " Constructor "), skill("s3", "__proto__")],
    });
    const index = assembleHookIndex(input);
    expect(Object.keys(index.skill_invocation_index!).sort()).toEqual(["__proto__", "constructor"]);
    expect(index.skill_invocation_index!["constructor"]!.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(Object.keys(assembleWarehouse(input))).toContain("__proto__");
    expect(JSON.parse(JSON.stringify(index)).skill_invocation_index.__proto__).toHaveLength(1);
  });

  it("builds the index when a stored description is not a string", () => {
    const description = { toString: null } as unknown as string;
    const odd = { id: "s1", name: "odd", description, content: "Step 1...", source: "manual", github_url: null };
    const index = assembleHookIndex(baseInput({ skills: [odd] }));
    expect(Object.keys(index.skill_invocation_index!)).toEqual(["odd"]);
  });
});

describe("project-wide knowledge for SessionStart", () => {
  const mem = (id: string, node_path: string, title: string, content: string) => ({ id, node_path, title, content });
  it("renders root memories with bodies while they fit, then titles with ids, and ignores scoped ones", async () => {
    const { buildProjectKnowledge, PROJECT_KNOWLEDGE_BODY_BUDGET } = await import("./hook-index.js");
    const big = "x".repeat(PROJECT_KNOWLEDGE_BODY_BUDGET - 40);
    const out = buildProjectKnowledge(
      [mem("a", "/", "A rule", "Durations are whole milliseconds."), mem("b", "/", "B big", big), mem("c", "", "C later", "never fits"), mem("d", "/lib", "Scoped", "SCOPED_BODY")],
      (m) => m.content,
    )!;
    expect(out).toContain("### A rule\nDurations are whole milliseconds.");
    expect(out).toContain("### C later\nnever fits");
    expect(out).toContain("- B big (id: b)");
    expect(out).not.toContain("SCOPED_BODY");
    expect(buildProjectKnowledge([mem("d", "/lib", "Scoped", "x")], (m) => m.content)).toBeNull();
  });

  it("puts the shortest bodies first, so one long pasted document cannot crowd out the rules", async () => {
    const { buildProjectKnowledge, PROJECT_KNOWLEDGE_BODY_BUDGET } = await import("./hook-index.js");
    const doc = "d".repeat(PROJECT_KNOWLEDGE_BODY_BUDGET - 5);
    const out = buildProjectKnowledge([mem("a", "/", "A long doc", doc), mem("z", "/", "Z short rule", "Ids are 16 hex chars.")], (m) => m.content)!;
    expect(out).toContain("### Z short rule\nIds are 16 hex chars.");
    expect(out).toContain("- A long doc (id: a)");
  });
});
