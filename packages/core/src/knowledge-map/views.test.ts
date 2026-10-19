// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { cluster, item, largeWorkspace, workspace } from "./__fixtures__/workspace.js";
import { ancestorDirectories, extractPathAnchors, resolveItemAnchors, resolveNodeAnchor } from "./anchors.js";
import { buildKnowledgeMap } from "./build.js";
import { clearKnowledgeMapCache, getCachedMap, loadKnowledgeMap } from "./cache.js";
import { parseKnowledgeMapInput } from "./input.js";
import { fileNameText, relatedKnowledge, renderRelated } from "./related.js";
import {
  ATLAS_MAX_CHARS,
  AUDIT_CHECKLIST,
  REGION_PAGE_MAX_CHARS,
  RELATED_MAX_CHARS,
  regionOpenGaps,
  regionPages,
  renderAtlas,
  renderRegion,
} from "./render.js";
import type { KnowledgeMap, KnowledgeRegion } from "./types.js";

const OPTIONS = { fingerprint: "fp-1", generatedAt: "2026-10-01T00:00:00.000Z" };

describe("views stay under their caps", () => {
  const map = buildKnowledgeMap(largeWorkspace(40, 50), OPTIONS);

  it("atlas, every region page and related output for a 2,000-item workspace", () => {
    expect(renderAtlas(map).length).toBeLessThanOrEqual(ATLAS_MAX_CHARS);
    for (const region of map.regions) {
      const pages = regionPages(map, region);
      for (let page = 1; page <= pages.length; page++) {
        expect(renderRegion(map, region, { page, purpose: "audit" }).length).toBeLessThanOrEqual(REGION_PAGE_MAX_CHARS);
      }
    }
    const related = relatedKnowledge(map, { itemIds: Object.keys(map.items).slice(0, 20), limit: 12 });
    expect(related.length).toBeLessThanOrEqual(12);
    expect(renderRelated(related).length).toBeLessThanOrEqual(RELATED_MAX_CHARS);
  });

  it("keeps the audit checklist short enough to travel with every audit page", () => {
    expect(AUDIT_CHECKLIST.length).toBeLessThanOrEqual(400);
    const region = map.regions[0]!;
    expect(renderRegion(map, region, { purpose: "audit" })).toContain(AUDIT_CHECKLIST);
    expect(renderRegion(map, region)).not.toContain(AUDIT_CHECKLIST);
  });

  it("pages a region and points at the next page", () => {
    const region = map.regions.find((r) => regionPages(map, r).length > 1);
    if (!region) return;
    expect(renderRegion(map, region, { page: 1 })).toContain(`page=2`);
    const pages = regionPages(map, region);
    const covered = new Set(pages.flatMap((page) => page.memberIds));
    expect(covered.size).toBe(region.memberIds.length);
  });
});

describe("relatedKnowledge", () => {
  const anchored = item("anchor-mem", "Relay replay ordering", "The relay in packages/relay/src/replay.ts must replay first.", "/packages/relay");
  // Filed away from the relay so that only its link reaches it.
  const linked = item("linked-rule", "Replay before streaming", "Enforces [[Relay replay ordering]].", "/docs", "rule");
  const map = buildKnowledgeMap(
    workspace([
      { items: [anchored, linked] },
      cluster({ prefix: "ui", size: 30, path: "/packages/app", words: ["panel", "toolbar", "theme"] }),
    ]),
    OPTIONS,
  );

  it("seeds files with the items that reference them, then their one-hop neighbours", () => {
    const out = relatedKnowledge(map, { files: ["packages/relay/src/replay.ts"] });
    expect(out[0]).toMatchObject({ id: "anchor-mem", seed: true, reason: "references packages/relay/src/replay.ts" });
    expect(out.find((e) => e.id === "linked-rule")).toMatchObject({ seed: false, reason: "links with Relay replay ordering" });
  });

  it("returns only one-hop neighbours, never the rest of a region (D6)", () => {
    const out = relatedKnowledge(map, { itemIds: ["ui-000"], limit: 12 });
    const neighbours = new Set(map.edges.flatMap((e) => (e.a === "ui-000" ? [e.b] : e.b === "ui-000" ? [e.a] : [])));
    for (const entry of out.filter((e) => !e.seed)) expect(neighbours.has(entry.id)).toBe(true);
    const chain = buildKnowledgeMap(
      workspace([
        {
          items: [
            item("a", "Alpha step", "Then [[Beta step]].", "/x"),
            item("b", "Beta step", "Then [[Gamma step]].", "/x"),
            item("c", "Gamma step", "Done.", "/x"),
          ],
        },
      ]),
      OPTIONS,
    );
    expect(relatedKnowledge(chain, { itemIds: ["a"] }).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("resolves titles and free-text queries to seeds", () => {
    expect(relatedKnowledge(map, { titles: ["relay-replay-ordering"] })[0]?.id).toBe("anchor-mem");
    expect(relatedKnowledge(map, { query: "replay before streaming" }).some((e) => e.id === "linked-rule")).toBe(true);
  });

  it("returns nothing for unknown seeds", () => {
    expect(relatedKnowledge(map, { itemIds: ["nope"], files: ["unrelated/file.ts"] })).toEqual([]);
    expect(renderRelated([])).toContain("No related knowledge");
  });
});

describe("relatedKnowledge ranks file evidence", () => {
  // Filler elsewhere, so a word in two of the items stays under the document-frequency cut.
  const filler = cluster({ prefix: "filler", size: 6, path: "/notes", words: ["unrelated", "ledger"] });
  const build = (items: ReturnType<typeof item>[]) => buildKnowledgeMap(workspace([{ items }, filler]), OPTIONS);
  const ids = (out: ReturnType<typeof relatedKnowledge>) => out.filter((e) => e.seed).map((e) => e.id);

  it("reads a reference relative to the item's own node", () => {
    const map = build([
      item("render", "Render in the foreground", "Run `scripts/render.mjs` in steps.", "/packages/film"),
      item("look", "Film palette", "Colours and type for every scene.", "/packages/film"),
    ]);
    const out = relatedKnowledge(map, { files: ["packages/film/scripts/render.mjs"] });
    expect(out[0]).toMatchObject({ id: "render", reason: "references packages/film/scripts/render.mjs" });
    expect(out.find((e) => e.id === "look")).toMatchObject({ seed: true, reason: "lives at /packages/film" });
  });

  it("seeds knowledge filed on the file's own directory at any depth, never the root", () => {
    const map = build([
      item("roles", "Name every role in a grant", "Revoking from public leaves authenticated.", "/supabase/migrations"),
      item("tone", "Write plainly", "Short sentences.", "/"),
    ]);
    const out = relatedKnowledge(map, { files: ["supabase/migrations/20261001_x.sql"] });
    expect(ids(out)).toEqual(["roles"]);
    expect(out[0]!.reason).toBe("lives at /supabase/migrations");
  });

  it("lets the files' names reorder what the files point at, never add to it", () => {
    const map = build([
      item("a-palette", "Palette tokens", "Colour tokens for both themes.", "/packages/x/src"),
      item("b-drag", "Motion timeline drag", "Keyframe drag rebuilds from a snapshot.", "/packages/x/src"),
      item("c-elsewhere", "Motion timeline export", "Exports keyframes.", "/packages/other"),
    ]);
    expect(ids(relatedKnowledge(map, { files: ["packages/x/src/MotionTimeline.tsx"] }))).toEqual(["b-drag", "a-palette"]);
  });

  it("lets a stated query outrank plain directory membership", () => {
    const map = build([
      item("a-caret", "Composer caret", "The caret anchors to the first line.", "/packages/x/src"),
      item("b-diff", "Tool row diff preview", "Every engine must fill the diff fields.", "/packages/y"),
    ]);
    const out = relatedKnowledge(map, { files: ["packages/x/src/ChatColumn.tsx"], query: "tool row diff preview" });
    expect(out[0]).toMatchObject({ id: "b-diff", reason: "matches the query" });
    expect(ids(out)).toContain("a-caret");
  });

  it("ranks a node further up below knowledge closer to the file, and the higher the lower", () => {
    const map = build([
      item("a-broad", "Cross-device sync", "Every surface syncs.", "/packages"),
      item("b-ios", "Build iOS UI from the design system", "Theme and Metrics tokens only.", "/packages/mobile"),
      item("c-chat", "Chat bubbles", "Bubble layout for cloud chat.", "/packages/mobile/App/Chat"),
    ]);
    const out = relatedKnowledge(map, { files: ["packages/mobile/App/Chat/LeaseView.swift"] });
    expect(ids(out)).toEqual(["c-chat", "b-ios", "a-broad"]);
    expect(out[1]!.reason).toBe("lives at /packages/mobile, above the file");
  });

  it("never lets a file name lift an item over stronger evidence", () => {
    const map = build([
      item("a-index", "Index rebuild loop", "Rebuilds the index nightly.", "/packages"),
      item("b-sdk", "SDK stays bounded", "Never degrade the host app.", "/packages/sdk"),
    ]);
    expect(ids(relatedKnowledge(map, { files: ["packages/sdk/src/index.ts"] }))).toEqual(["b-sdk", "a-index"]);
  });

  it("weighs a reference by how many areas its item names", () => {
    const map = build([
      item("a-map", "Monorepo map", "Areas: packages/a/x, packages/b/y, packages/c/z, packages/sdk/src/index.ts.", "/"),
      item("b-sdk", "SDK internals", "How the SDK is built.", "/packages/sdk/src"),
    ]);
    const out = relatedKnowledge(map, { files: ["packages/sdk/src/index.ts"] });
    expect(ids(out)).toEqual(["b-sdk", "a-map"]);
    expect(out[1]!.reason).toBe("references packages/sdk/src/index.ts");
  });

  it("splits a file name into the words it carries", () => {
    expect(fileNameText("packages/app/src/studio/design/DesignMotionDock.tsx")).toBe("DesignMotionDock Design Motion Dock");
    expect(fileNameText("adapters/recovery-coordinator.ts")).toBe("recovery-coordinator recovery coordinator");
  });
});

describe("loadKnowledgeMap", () => {
  afterEach(() => clearKnowledgeMapCache());
  const map = buildKnowledgeMap(workspace([cluster({ prefix: "pay", size: 4, path: "/p", words: ["a1", "b2", "c3"] })]), OPTIONS);

  it("builds once per fingerprint and serves the cache after", async () => {
    let builds = 0;
    const build = async () => {
      builds++;
      return map;
    };
    expect(await loadKnowledgeMap({ workspaceId: "ws", fingerprint: "fp-1", build })).toEqual({ status: "ready", map });
    expect(await loadKnowledgeMap({ workspaceId: "ws", fingerprint: "fp-1", build })).toEqual({ status: "ready", map });
    expect(builds).toBe(1);
    expect(getCachedMap("ws")).toBe(map);
    expect(getCachedMap("other")).toBeNull();
  });

  it("says computing when the budget runs out and hands the finished map to the next call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const build = async () => {
      await gate;
      return map;
    };
    expect(await loadKnowledgeMap({ workspaceId: "ws", fingerprint: "fp-2", build, budgetMs: 5 })).toMatchObject({ status: "computing" });
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await loadKnowledgeMap({ workspaceId: "ws", fingerprint: "fp-2", build, budgetMs: 5 })).toEqual({ status: "ready", map });
  });

  it("reports a failed build as an error, not as computing", async () => {
    const failure = new Error("rpc failed");
    const result = await loadKnowledgeMap({ workspaceId: "ws", fingerprint: "fp-3", build: async () => Promise.reject(failure) });
    expect(result).toEqual({ status: "error", error: failure });
  });
});

describe("parseKnowledgeMapInput", () => {
  it("accepts a well-formed payload and falls back to lexical without neighbours", () => {
    const parsed = parseKnowledgeMapInput("ws", {
      items: [{ id: "a", kind: "rule", title: "T", body: "B", node_paths: ["/x", 4], updated_at: "2026-01-01" }],
      neighbours: [["a", "b", 0.7], ["bad"], ["a", "b", "0.7"]],
      semantic: "voyage",
      usage: { a: 2, b: "x" },
      usage_window_days: 90,
    });
    expect(parsed).toEqual({
      workspaceId: "ws",
      items: [{ id: "a", kind: "rule", title: "T", description: null, body: "B", nodePaths: ["/x"], updatedAt: "2026-01-01" }],
      neighbours: [["a", "b", 0.7]],
      semantic: "voyage",
      usage: { a: 2 },
      usageWindowDays: 90,
    });
    expect(parseKnowledgeMapInput("ws", { items: [], semantic: "voyage" }).semantic).toBe("lexical");
  });

  it("throws on a payload the map cannot trust", () => {
    expect(() => parseKnowledgeMapInput("ws", null)).toThrow("items missing");
    expect(() => parseKnowledgeMapInput("ws", { items: [{ id: "a", kind: "signal", title: "x" }] })).toThrow("bad item");
  });
});

describe("extractPathAnchors", () => {
  it("reads path references, skips URLs, and normalizes", () => {
    expect(
      extractPathAnchors("Edit `packages/cli/src/index.ts`, see ./docs/plan.md and /supabase/migrations. Not https://github.com/a/b or and-or."),
    ).toEqual(["packages/cli/src/index.ts", "docs/plan.md", "supabase/migrations"]);
    expect(ancestorDirectories("a/b/c.ts")).toEqual(["a/b", "a"]);
  });

  it("reads a reference relative to the item's node", () => {
    expect(resolveNodeAnchor("scripts/plan.mjs", "/packages/film")).toBe("packages/film/scripts/plan.mjs");
    expect(resolveNodeAnchor("adapters/codex.ts", "/packages/app/electron/agent-gateway/adapters")).toBe("packages/app/electron/agent-gateway/adapters/codex.ts");
    expect(resolveNodeAnchor("src/studio/chat/x.ts", "packages/app/src/studio/design")).toBe("packages/app/src/studio/chat/x.ts");
    // Already workspace-relative, or filed at the root: nothing to resolve.
    expect(resolveNodeAnchor("packages/cli/src/index.ts", "/packages/film")).toBeNull();
    expect(resolveNodeAnchor("scripts/plan.mjs", "/")).toBeNull();
    expect(resolveItemAnchors(["scripts/plan.mjs", "packages/film/src"], ["/packages/film"])).toEqual([
      "scripts/plan.mjs",
      "packages/film/src",
      "packages/film/scripts/plan.mjs",
    ]);
  });
});

describe("regionOpenGaps", () => {
  const map = {
    items: {
      a: { anchors: ["packages/relay/src/replay.ts"], nodePaths: ["/"] },
      b: { anchors: ["packages/app/electron"], nodePaths: ["/packages"] },
      c: { anchors: [], nodePaths: ["/packages/cli/"] },
    },
  } as unknown as KnowledgeMap;
  const region = (memberIds: string[]) => ({ memberIds }) as unknown as KnowledgeRegion;

  it("counts a gap holding a referenced file, an anchoring ancestor, or a node on or above it", () => {
    expect(regionOpenGaps(map, region(["a"]), ["packages/relay/src", "packages/relay/test"])).toBe(1);
    // A depth-3 ancestor anchors the gap below it; a depth-1 node path does not.
    expect(regionOpenGaps(map, region(["b"]), ["packages/app/electron/services", "packages/web/src"])).toBe(1);
    expect(regionOpenGaps(map, region(["c"]), ["packages/cli/src", "packages/clix/src"])).toBe(1);
    // The root node touches nothing.
    expect(regionOpenGaps(map, region(["a"]), ["packages/web/src"])).toBe(0);
  });
});
