// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pure hook-supervisor matchers.
// These run in the MCP server's test pipeline (shared package is source-only).

import { describe, expect, it } from "vitest";
import {
  ancestorPaths,
  extractRuleSymbols,
  filterMemoriesByRelevance,
  filterRulesByRelevance,
  formatInjectionContext,
  keywordOverlap,
  matchMemoriesForPath,
  matchEnforcementRulesForPath,
  matchRulesForPath,
  memoryRelevanceScore,
  relevanceThreshold,
  selectSemanticMemoryCandidates,
  tokenize,
  toRelative,
} from "@pathrule/core/retrieval/matcher.js";
import type { HookIndex, MemoryStub, RuleStub } from "@pathrule/protocol/hook-index.js";

function memory(id: string, title: string, nodePath: string, semanticTags?: string[]): MemoryStub {
  return {
    id,
    title,
    preview: `${title} preview`,
    node_path: nodePath,
    semantic_tags: semanticTags,
  };
}

function rule(
  id: string,
  name: string,
  priority: RuleStub["priority"],
  scopeType: RuleStub["scope_type"],
  enforcement: RuleStub["enforcement"] = "advisory",
): RuleStub {
  return {
    id,
    name,
    priority,
    scope_type: scopeType,
    enforcement,
    preview: `${name} preview`,
  };
}

function makeIndex(overrides: Partial<HookIndex> = {}): HookIndex {
  return {
    schema_version: 1,
    workspace_id: "ws-1",
    workspace_root: "/Users/me/repo",
    generated_at: new Date().toISOString(),
    path_memories: {},
    path_rules: {},
    project_rules: [],
    recent_subjects: [],
    session_digest: null,
    ...overrides,
  };
}

describe("toRelative", () => {
  it("returns '/' for the workspace root exactly", () => {
    expect(toRelative("/Users/me/repo", "/Users/me/repo")).toBe("/");
  });

  it("strips workspace root and prefixes with '/'", () => {
    expect(toRelative("/Users/me/repo/packages/app/src/x.ts", "/Users/me/repo")).toBe(
      "/packages/app/src/x.ts",
    );
  });

  it("returns null for paths outside the workspace", () => {
    expect(toRelative("/tmp/nope.ts", "/Users/me/repo")).toBeNull();
    expect(toRelative("/Users/me/other/x.ts", "/Users/me/repo")).toBeNull();
  });
});

describe("ancestorPaths", () => {
  it("walks from specific to root", () => {
    expect(ancestorPaths("/packages/app/src/store")).toEqual([
      "/packages/app/src/store",
      "/packages/app/src",
      "/packages/app",
      "/packages",
      "/",
    ]);
  });

  it("returns only '/' for root", () => {
    expect(ancestorPaths("/")).toEqual(["/"]);
  });
});

describe("matchMemoriesForPath", () => {
  it("collects memories from all ancestors, closest first, deduped", () => {
    const index = makeIndex({
      path_memories: {
        "/packages/app": [memory("m-app", "App note", "/packages/app")],
        "/packages/app/src": [memory("m-src", "Src note", "/packages/app/src")],
        "/": [memory("m-root", "Root note", "/")],
      },
    });

    const hits = matchMemoriesForPath(index, "/packages/app/src/store/workspace.ts", { limit: 10 });
    expect(hits.map((m) => m.id)).toEqual(["m-src", "m-app", "m-root"]);
  });

  it("respects the limit cap", () => {
    const index = makeIndex({
      path_memories: {
        "/": Array.from({ length: 10 }).map((_, i) => memory(`m-${i}`, `t${i}`, "/")),
      },
    });
    const hits = matchMemoriesForPath(index, "/anywhere", { limit: 3 });
    expect(hits).toHaveLength(3);
  });
});

describe("matchRulesForPath", () => {
  it("combines path-scoped rules with project rules, priority sorted", () => {
    const index = makeIndex({
      path_rules: {
        "/packages/app": [rule("r-folder", "Folder rule", "medium", "folder")],
      },
      project_rules: [
        rule("r-project-hi", "Always high", "high", "project"),
        rule("r-project-lo", "Low project", "low", "project"),
      ],
    });
    const hits = matchRulesForPath(index, "/packages/app/src/x.ts", { limit: 10 });
    // high first (even though project), then medium folder rule, then low project
    expect(hits.map((r) => r.id)).toEqual(["r-project-hi", "r-folder", "r-project-lo"]);
  });

  it("surfaces a strict rule with its enforcement flag intact", () => {
    const index = makeIndex({
      project_rules: [rule("r-strict", "Strict", "high", "project", "strict")],
    });
    const hits = matchRulesForPath(index, "/anywhere");
    expect(hits[0]?.enforcement).toBe("strict");
  });
});

describe("matchEnforcementRulesForPath", () => {
  const BLOCK = { source: "cursor:\\s*pointer", flags: "i", message: "Use a real button." };

  /** A strict, medium-priority rule buried behind more high-priority rules than the budget. */
  function buriedIndex(): HookIndex {
    const high = Array.from({ length: 20 }, (_, i) =>
      rule(`r-high-${i}`, `High ${i}`, "high", "project"),
    );
    const strict = { ...rule("r-33", "Never use cursor: pointer", "medium", "project", "strict"), block_pattern: BLOCK };
    return makeIndex({ project_rules: [...high, strict] });
  }

  it("returns a strict rule the context budget would have dropped", () => {
    const index = buriedIndex();
    // The display list cuts it: this is the regression being guarded.
    expect(matchRulesForPath(index, "/anywhere", { limit: 12 }).map((r) => r.id)).not.toContain("r-33");
    expect(matchEnforcementRulesForPath(index, "/anywhere").map((r) => r.id)).toEqual(["r-33"]);
  });

  it("takes no limit, so a large rule set cannot disarm a constraint", () => {
    const index = buriedIndex();
    expect(matchEnforcementRulesForPath(index, "/anywhere")).toHaveLength(1);
    expect(matchRulesForPath(index, "/anywhere")).toHaveLength(5); // default display budget, unchanged
  });

  it("excludes non-strict rules and strict rules with no compiled pattern", () => {
    const index = makeIndex({
      project_rules: [
        rule("r-advisory", "Advisory", "high", "project"),
        // enforcement=strict but nothing compiled: the legacy column-only rows. Not scanned.
        rule("r-strict-no-pattern", "Strict, no pattern", "high", "project", "strict"),
        { ...rule("r-armed", "Armed", "low", "project", "strict"), block_pattern: BLOCK },
      ],
    });
    expect(matchEnforcementRulesForPath(index, "/anywhere").map((r) => r.id)).toEqual(["r-armed"]);
  });

  it("respects rule scope: a folder rule does not apply outside its subtree", () => {
    const index = makeIndex({
      path_rules: {
        "/packages/app": [
          { ...rule("r-scoped", "Scoped", "medium", "folder", "strict"), block_pattern: BLOCK },
        ],
      },
    });
    expect(matchEnforcementRulesForPath(index, "/packages/app/src/x.ts").map((r) => r.id)).toEqual([
      "r-scoped",
    ]);
    expect(matchEnforcementRulesForPath(index, "/packages/web/x.ts")).toEqual([]);
  });

  it("admits a PATH-ONLY atom, which carries no content pattern", () => {
    // The divergence this guards: pathrule-hook.js denies on block_path alone, so a
    // matcher that required block_pattern would make the two sides disagree.
    const index = makeIndex({
      project_rules: [
        {
          ...rule("r-mobile-md", "Never add markdown under Pathrule/", "medium", "project", "strict"),
          block_path: {
            scope_path: "/packages/mobile/Pathrule",
            file_extensions: [".md"],
            message: "Scope mobile knowledge at /packages/mobile.",
          },
        },
      ],
    });
    expect(matchEnforcementRulesForPath(index, "/anywhere").map((r) => r.id)).toEqual(["r-mobile-md"]);
  });

  it("does not change what the context channel shows", () => {
    const index = buriedIndex();
    const before = matchRulesForPath(index, "/anywhere", { limit: 12 }).map((r) => r.id);
    matchEnforcementRulesForPath(index, "/anywhere");
    expect(matchRulesForPath(index, "/anywhere", { limit: 12 }).map((r) => r.id)).toEqual(before);
  });
});

describe("formatInjectionContext", () => {
  it("returns null when nothing matches", () => {
    const out = formatInjectionContext({
      relativePath: "/x",
      memories: [],
      rules: [],
      failPatterns: [],
    });
    expect(out).toBeNull();
  });

  it("renders a compact context with rule + memory sections", () => {
    const out = formatInjectionContext({
      relativePath: "/packages/app/x.ts",
      memories: [memory("m1", "Note", "/packages/app")],
      rules: [rule("r1", "Some rule", "high", "folder")],
      failPatterns: [],
    });
    expect(out).toMatch(/Pathrule context for \/packages\/app\/x\.ts/);
    expect(out).toMatch(/Some rule/);
    expect(out).toMatch(/Note/);
  });

  it("highlights strict rules above advisory ones with the 🚨 marker", () => {
    const out = formatInjectionContext({
      relativePath: "/x",
      memories: [],
      rules: [
        rule("r-adv", "Soft rule", "medium", "project"),
        rule("r-strict", "Hard rule", "high", "project", "strict"),
      ],
      failPatterns: [],
    });
    // strict section appears before advisory section
    const strictIdx = out?.indexOf("🚨 Strict rules") ?? -1;
    const advisoryIdx = out?.indexOf("Rules in scope:") ?? -1;
    expect(strictIdx).toBeGreaterThanOrEqual(0);
    expect(advisoryIdx).toBeGreaterThan(strictIdx);
  });

  it("renders semantic candidates as title-only nudges", () => {
    const out = formatInjectionContext({
      relativePath: "/x",
      memories: [],
      rules: [],
      semanticCandidates: [
        {
          id: "m-sem",
          title: "Component Variant Map",
          node_path: "/apps/mobile/brands",
          confidence: "high",
        },
      ],
      failPatterns: [],
    });

    expect(out).toContain("Possible semantic memory candidates");
    expect(out).toContain("Component Variant Map");
    expect(out).toContain("pathrule_read_memory");
    expect(out).not.toContain("preview");
  });
});

// ─── Relevance + dedup ───────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases, drops short tokens and stopwords", () => {
    const tokens = tokenize("The chokidar.close() blocks FSEvents");
    expect(tokens.has("chokidar")).toBe(true);
    expect(tokens.has("close")).toBe(true);
    expect(tokens.has("blocks")).toBe(true);
    expect(tokens.has("fsevents")).toBe(true);
    expect(tokens.has("the")).toBe(false); // stopword
    expect(tokens.has("()")).toBe(false);
  });

  it("handles Turkish characters", () => {
    const tokens = tokenize("İstek sırası değiştirildi");
    // "ile", "bir", "ve" would be stripped; real words pass
    expect(tokens.size).toBeGreaterThan(0);
  });

  it("returns empty set for null/undefined/empty", () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
    expect(tokenize("").size).toBe(0);
  });
});

describe("keywordOverlap", () => {
  it("counts shared tokens between context and target", () => {
    const ctx = tokenize("packages/app/src/components/Sidebar.tsx renderer workspace");
    expect(keywordOverlap(ctx, "Zustand selector stability rule")).toBe(0);
    expect(keywordOverlap(ctx, "Sidebar renderer pattern")).toBeGreaterThanOrEqual(2);
  });
});

describe("relevanceThreshold", () => {
  it("returns priority-adjusted thresholds", () => {
    expect(relevanceThreshold("high")).toBe(1);
    expect(relevanceThreshold("medium")).toBe(2);
    expect(relevanceThreshold("low")).toBe(3);
  });
});

describe("filterRulesByRelevance", () => {
  function ruleWith(
    id: string,
    priority: RuleStub["priority"],
    preview: string,
    extras: Partial<RuleStub> = {},
  ): RuleStub {
    return {
      id,
      name: `rule ${id}`,
      scope_type: "folder",
      priority,
      enforcement: "advisory",
      preview,
      ...extras,
    };
  }

  it("always keeps strict rules, even with zero overlap", () => {
    const rules = [ruleWith("r1", "high", "chokidar close", { enforcement: "strict" })];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("some jsx field reorder"),
      contextText: "some jsx field reorder",
      seenRuleIds: new Set(),
    });
    expect(kept).toHaveLength(1);
  });

  it("drops high-priority advisory rule with zero keyword overlap", () => {
    const rules = [ruleWith("r1", "high", "chokidar close main thread FSEvents")];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("Sidebar.tsx field reorder form"),
      contextText: "Sidebar.tsx field reorder form",
      seenRuleIds: new Set(),
    });
    expect(kept).toHaveLength(0);
  });

  it("keeps high-priority rule with at least one keyword hit", () => {
    const rules = [ruleWith("r1", "high", "Sidebar renderer pattern")];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("packages/app/src/components/Sidebar.tsx edit"),
      contextText: "packages/app/src/components/Sidebar.tsx edit",
      seenRuleIds: new Set(),
    });
    expect(kept).toHaveLength(1);
  });

  it("requires 2 overlapping tokens for medium priority", () => {
    const rules = [
      ruleWith("r1", "medium", "Sidebar renderer only single match"),
      ruleWith("r2", "medium", "Sidebar renderer two tokens match"),
    ];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("Sidebar renderer edit"),
      contextText: "Sidebar renderer edit",
      seenRuleIds: new Set(),
    });
    // both have ≥2 overlap ("sidebar", "renderer") → both kept
    expect(kept.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("drops rule already seen in this session", () => {
    const rules = [ruleWith("r1", "medium", "Sidebar renderer pattern extra keywords")];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("Sidebar renderer pattern"),
      contextText: "Sidebar renderer pattern",
      seenRuleIds: new Set(["r1"]),
    });
    expect(kept).toHaveLength(0);
  });

  it("symbols array hard-gates priority-bağımsız (no hit → drop even high)", () => {
    const rules = [ruleWith("r1", "high", "rule body", { symbols: ["chokidar.close"] })];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("Sidebar jsx reorder"),
      contextText: "Sidebar.tsx jsx reorder",
      seenRuleIds: new Set(),
    });
    expect(kept).toHaveLength(0);
  });

  it("symbols array hit keeps rule regardless of keyword overlap", () => {
    const rules = [ruleWith("r1", "low", "rule body", { symbols: ["chokidar.close"] })];
    const kept = filterRulesByRelevance({
      rules,
      contextTokens: tokenize("some file"),
      contextText: "await chokidar.close() here",
      seenRuleIds: new Set(),
    });
    expect(kept).toHaveLength(1);
  });
});

describe("filterMemoriesByRelevance", () => {
  it("drops memory with zero keyword overlap", () => {
    const memories = [memory("m1", "IPC keychain deadlock chokidar", "/")];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize("Sidebar.tsx jsx field reorder"),
      seenMemoryIds: new Set(),
    });
    expect(kept).toHaveLength(0);
  });

  it("ignores generic path and patch tokens for memory relevance", () => {
    const contextTokens = tokenize(
      "packages/app/src/components/content/suggestions/SuggestionsTab.tsx old new patch",
    );

    expect(
      memoryRelevanceScore(
        contextTokens,
        "macOS app icon size must be 824x824; regenerate assets in packages/app",
      ),
    ).toBe(0);
  });

  it("keeps memory with at least one keyword hit", () => {
    const memories = [memory("m1", "Sidebar resize pattern", "/packages/app/src/components")];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize("Sidebar.tsx jsx reorder"),
      seenMemoryIds: new Set(),
    });
    expect(kept).toHaveLength(1);
  });

  it("requires stronger evidence for broad root/app memories", () => {
    const memories = [memory("m1", "IPC root cause keychain", "/packages/app")];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize("Suggestions root badge"),
      seenMemoryIds: new Set(),
    });
    expect(kept).toHaveLength(0);
  });

  it("ranks relevant and deeper memories before broad ancestor noise", () => {
    const memories = [
      memory("m-icon", "macOS app icon packages content", "/packages/app"),
      memory("m-root-ui", "UI tone scale suggestions badge surface", "/packages/app"),
      memory(
        "m-deep-ui",
        "Suggestions detail popover root badge standard",
        "/packages/app/src/components/content/suggestions",
      ),
    ];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize(
        "packages/app/src/components/content/suggestions/SuggestionsTab.tsx suggestions root badge detail popover",
      ),
      seenMemoryIds: new Set(),
      limit: 2,
    });

    expect(kept.map((m) => m.id)).toEqual(["m-deep-ui", "m-root-ui"]);
  });

  it("uses semantic tags as a boost, not a standalone pass", () => {
    const memories = [
      memory("m-no-token", "Unrelated renderer note", "/packages/app", ["frontend", "ui"]),
      memory("m-boosted", "Modal workflow", "/packages/app", ["frontend", "ui", "i18n"]),
    ];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize("modal i18n"),
      contextSemanticTags: ["frontend", "ui", "i18n"],
      seenMemoryIds: new Set(),
    });

    expect(kept.map((m) => m.id)).toEqual(["m-boosted"]);
  });

  it("respects seenMemoryIds dedup", () => {
    const memories = [memory("m1", "Sidebar pattern", "/")];
    const kept = filterMemoriesByRelevance({
      memories,
      contextTokens: tokenize("Sidebar pattern edit"),
      seenMemoryIds: new Set(["m1"]),
    });
    expect(kept).toHaveLength(0);
  });
});

describe("selectSemanticMemoryCandidates", () => {
  it("selects at most three title-only candidates from the whole hook index", () => {
    const index = makeIndex({
      path_memories: {
        "/apps/mobile/brands": [
          memory("m-variants", "Component variants layout schema", "/apps/mobile/brands", [
            "ui",
            "config",
            "mobile",
          ]),
        ],
        "/packages/app": [
          memory("m-ui", "Brand variant card layout", "/packages/app", ["ui"]),
          memory("m-auth", "MCP auth cache architecture", "/packages/mcp-server", ["auth", "mcp"]),
          memory("m-extra", "Variant registry defaults", "/apps/mobile/src", ["config"]),
        ],
      },
    });

    const hits = selectSemanticMemoryCandidates({
      index,
      contextTokens: tokenize("App'teki component variant layout seçenekleri neler"),
      contextSemanticTags: ["ui", "config"],
      seenMemoryIds: new Set(),
      limit: 3,
    });

    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      id: "m-variants",
      confidence: "high",
      node_path: "/apps/mobile/brands",
    });
    expect(hits.every((hit) => !("preview" in hit))).toBe(true);
  });

  it("dedups previously surfaced semantic candidates", () => {
    const index = makeIndex({
      path_memories: {
        "/": [memory("m1", "MCP auth cache", "/", ["auth", "mcp"])],
      },
    });

    const hits = selectSemanticMemoryCandidates({
      index,
      contextTokens: tokenize("mcp auth cache"),
      contextSemanticTags: ["auth", "mcp"],
      seenMemoryIds: new Set(["m1"]),
    });

    expect(hits).toEqual([]);
  });
});

describe("extractRuleSymbols", () => {
  it("picks up markdown inline-code identifiers", () => {
    const content = "Avoid `chokidar.close()` on main thread. Prefer the `queueMicrotask` pattern.";
    const symbols = extractRuleSymbols(content);
    expect(symbols).toContain("chokidar.close()");
    expect(symbols).toContain("queueMicrotask");
  });

  it("ignores prose wrapped in backticks", () => {
    const content = "See `how we did this before` for context.";
    expect(extractRuleSymbols(content)).toBeUndefined();
  });

  it("returns undefined when content has no inline-code", () => {
    expect(extractRuleSymbols("plain rule body, no backticks")).toBeUndefined();
    expect(extractRuleSymbols("")).toBeUndefined();
  });

  it("caps at limit", () => {
    const content = ["a.b", "c.d", "e.f", "g.h", "i.j", "k.l", "m.n", "o.p", "q.r"]
      .map((s) => `\`${s}\``)
      .join(" ");
    const symbols = extractRuleSymbols(content, 5);
    expect(symbols).toHaveLength(5);
  });
});
