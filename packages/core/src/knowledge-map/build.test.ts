// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cluster, item, largeWorkspace, workspace } from "./__fixtures__/workspace.js";
import { buildKnowledgeMap, oneLiner, pathArea, primaryPath } from "./build.js";
import { partition } from "./partition.js";
import { KNOWLEDGE_MAP_ALGORITHM } from "./types.js";

const OPTIONS = { fingerprint: "fp", generatedAt: "2026-10-01T00:00:00.000Z" };
const groupOf = (map: ReturnType<typeof buildKnowledgeMap>, id: string): string | null =>
  map.items[id]!.subRegionId ?? map.items[id]!.regionId;

describe("buildKnowledgeMap", () => {
  const input = workspace([
    cluster({ prefix: "pay", size: 8, path: "/packages/billing", words: ["invoice", "charge", "refund"] }),
    cluster({ prefix: "font", size: 8, path: "/packages/editor", words: ["glyph", "kerning", "typeface"] }),
    cluster({ prefix: "sync", size: 8, path: "/packages/relay", words: ["reconnect", "replay", "cursor"] }),
  ]);

  it("is deterministic and independent of input order, region ids included", () => {
    const a = buildKnowledgeMap(input, OPTIONS);
    const b = buildKnowledgeMap({ ...input, items: [...input.items].reverse(), neighbours: [...input.neighbours].reverse() }, OPTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.algorithm).toBe(KNOWLEDGE_MAP_ALGORITHM);
    expect(a.regions.every((region) => /^rg_[0-9a-f]{8}$/.test(region.id))).toBe(true);
  });

  it("puts each topic in its own region, homed on its folder", () => {
    const map = buildKnowledgeMap(input, OPTIONS);
    expect(map.regions).toHaveLength(3);
    for (const prefix of ["pay", "font", "sync"]) {
      const regions = new Set(Object.values(map.items).filter((i) => i.id.startsWith(prefix)).map((i) => i.regionId));
      expect(regions.size).toBe(1);
    }
    expect(map.regions.map((r) => r.homePath).sort()).toEqual(["/packages/billing", "/packages/editor", "/packages/relay"]);
    expect(map.regions.every((r) => r.pathFit === 1 && r.memberIds.length === 8)).toBe(true);
  });

  it("splits a small topic out of the big region it hangs on (resolution limit, D2)", () => {
    const big = cluster({ prefix: "ui", size: 40, path: "/packages/app", words: ["panel", "toolbar", "theme"] });
    const small = cluster({ prefix: "e2e", size: 5, path: "/packages/app", words: ["cipher", "nonce", "envelope"] });
    small.items[0]!.body += " also see [[ui note 0]]";
    const map = buildKnowledgeMap(workspace([big, small]), OPTIONS);
    const smallGroups = new Set(small.items.map((i) => groupOf(map, i.id)));
    expect(smallGroups.size).toBe(1);
    const group = [...smallGroups][0];
    expect(big.items.some((i) => groupOf(map, i.id) === group)).toBe(false);
  });

  it("gives an edge-less item a path home (loose) and an edge-less root item to conventions (D9)", () => {
    const map = buildKnowledgeMap(
      workspace([
        cluster({ prefix: "pay", size: 6, path: "/packages/billing", words: ["invoice", "charge", "refund"] }),
        { items: [item("lonely", "Zxqv", "Qwzx", "/packages/billing/src", "memory"), item("root-rule", "Vbnm", "Mnbv", "/", "rule")] },
      ]),
      OPTIONS,
    );
    expect(map.items.lonely!.loose).toBe(true);
    expect(map.items.lonely!.regionId).toBe(map.items["pay-000"]!.regionId);
    expect(map.items["root-rule"]!.regionId).toBeNull();
    expect(map.conventions).toEqual(["root-rule"]);
  });

  it("finds near-duplicate memories as one consolidation group, and nothing for distinct ones", () => {
    const dupes = ["d1", "d2", "d3", "d4"].map((id) => item(id, `Codex tool name bug ${id}`, "canonicalize the tool name after normalization", "/packages/hook"));
    const neighbours: Array<[string, string, number]> = [];
    for (const a of dupes) for (const b of dupes) if (a !== b) neighbours.push([a.id, b.id, 0.92]);
    const map = buildKnowledgeMap(workspace([{ items: dupes, neighbours }, cluster({ prefix: "pay", size: 6, path: "/p", words: ["invoice", "charge", "refund"] })]), OPTIONS);
    const groups = map.findings.filter((f) => f.kind === "consolidate");
    expect(groups).toEqual([{ kind: "consolidate", itemIds: ["d1", "d2", "d3", "d4"], maxSimilarity: 0.92 }]);
  });

  it("reports a rule, skill and memory saying the same thing as unlinked companions, not duplicates", () => {
    const text = "orbit relay must replay the cursor after reconnect before streaming envelopes";
    const companions = [
      item("c-rule", "Replay before streaming", text, "/packages/relay", "rule"),
      item("c-skill", "relay-replay", text, "/packages/relay", "skill"),
      item("c-mem", "Relay replay ordering", text, "/packages/relay", "memory"),
    ];
    const filler = cluster({ prefix: "pay", size: 12, path: "/p", words: ["invoice", "charge", "refund"] });
    const filler2 = cluster({ prefix: "font", size: 12, path: "/q", words: ["glyph", "kerning", "typeface"] });
    const map = buildKnowledgeMap(workspace([{ items: companions }, filler, filler2], { semantic: "lexical", neighbours: [] }), OPTIONS);
    const pairs = map.findings.filter((f) => f.kind === "companion_unlinked").map((f) => ("itemIds" in f ? f.itemIds.join("+") : ""));
    expect(pairs).toEqual(expect.arrayContaining(["c-mem+c-rule", "c-mem+c-skill", "c-rule+c-skill"]));
    expect(map.findings.some((f) => f.kind === "consolidate")).toBe(false);
  });

  it("counts links by stage and reports dangling [[links]] but not unknown ::names", () => {
    const map = buildKnowledgeMap(
      workspace([{ items: [item("a", "Alpha note", "see [[beta-note]] and [[missing-thing-entirely]] and ::before"), item("b", "Beta note", "x")] }]),
      OPTIONS,
    );
    expect(map.links.resolved).toBe(1);
    expect(map.links.byStage.exact).toBe(1);
    expect(map.findings.filter((f) => f.kind === "dangling_link")).toEqual([{ kind: "dangling_link", itemId: "a", target: "missing-thing-entirely" }]);
  });

  it("marks unused items only when usage is known", () => {
    const base = workspace([cluster({ prefix: "pay", size: 4, path: "/p", words: ["invoice", "charge", "refund"] })]);
    expect(buildKnowledgeMap(base, OPTIONS).findings.some((f) => f.kind === "unused")).toBe(false);
    const withUsage = buildKnowledgeMap({ ...base, usage: { "pay-000": 3 }, usageWindowDays: 90 }, OPTIONS);
    expect(withUsage.findings.filter((f) => f.kind === "unused").map((f) => ("itemId" in f ? f.itemId : ""))).toEqual(["pay-001", "pay-002", "pay-003"]);
    expect(withUsage.items["pay-000"]!.sessions).toBe(3);
  });

  it("builds a 2,000-item workspace within the 3 s budget", () => {
    const started = performance.now();
    const map = buildKnowledgeMap(largeWorkspace(40, 50), OPTIONS);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(Object.keys(map.items)).toHaveLength(2_000);
  });
});

describe("partition", () => {
  it("returns singletons for a graph without edges", () => {
    expect(partition(["b", "a"], [])).toEqual({ communities: [["a"], ["b"]], modularity: 0 });
  });
});

describe("helpers", () => {
  it("primaryPath, pathArea and oneLiner", () => {
    expect(primaryPath({ nodePaths: ["/z", "/a/b/"] })).toBe("/a/b");
    expect(primaryPath({ nodePaths: [] })).toBe("/");
    expect(pathArea("/packages/app/src/studio")).toBe("/packages/app");
    expect(oneLiner("# Title\n\n---\nname: x\nShort.\nThe first real sentence of the body is here.")).toBe("The first real sentence of the body is here.");
  });
});
