// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeBackend } from "../index.js";
import type { ToolContext } from "../tools/types.js";
import { cluster, item, workspace } from "./__fixtures__/workspace.js";
import { clearKnowledgeMapCache } from "./cache.js";
import { ATLAS_MAX_CHARS } from "./render.js";
import { KNOWLEDGE_MAP_TOOL_DESCRIPTION, knowledgeMapHandler } from "./tool.js";

const WS = "11111111-1111-4111-8111-111111111111";
const input = workspace(
  [
    cluster({ prefix: "ui", size: 30, path: "/packages/app", words: ["panel", "toolbar", "theme"] }),
    { items: [item("anchor-mem", "Relay replay ordering", "See packages/relay/src/replay.ts before streaming.", "/packages/relay")] },
  ],
  { workspaceId: WS },
);

function ctxWith(backend: Partial<KnowledgeBackend>): ToolContext {
  return { backend: backend as KnowledgeBackend, userId: "u", workspaceId: WS };
}

function mapBackend(overrides: Partial<KnowledgeBackend> = {}) {
  const buildKnowledgeMapInput = vi.fn(async () => input);
  const knowledgeMapFingerprint = vi.fn(async () => "fp-1");
  return { backend: { buildKnowledgeMapInput, knowledgeMapFingerprint, ...overrides }, buildKnowledgeMapInput, knowledgeMapFingerprint };
}

afterEach(() => clearKnowledgeMapCache());

describe("knowledgeMapHandler", () => {
  it("answers the atlas under its cap and builds once per fingerprint", async () => {
    const { backend, buildKnowledgeMapInput } = mapBackend();
    const first = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "atlas" });
    expect(first.ok && first.data.status).toBe("ready");
    expect(first.ok && first.data.text!.length).toBeLessThanOrEqual(ATLAS_MAX_CHARS);
    await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "atlas" });
    expect(buildKnowledgeMapInput).toHaveBeenCalledTimes(1);
  });

  it("shows open and closed gaps on the atlas, per region where its knowledge touches them", async () => {
    const plain = await knowledgeMapHandler(ctxWith(mapBackend().backend), { workspace_id: WS, view: "atlas" });
    clearKnowledgeMapCache();
    const knowledgeGapSummary = vi.fn(async () => ({ openScopes: ["packages/app/src", "packages/film"], closedLast30Days: 3 }));
    const out = await knowledgeMapHandler(ctxWith(mapBackend({ knowledgeGapSummary }).backend), { workspace_id: WS, view: "atlas" });
    const text = out.ok ? out.data.text! : "";
    expect(text).toContain("Knowledge gaps: 2 open, 3 closed in 30 days.");
    expect(text).toContain("| open gaps |");
    // Every region's items sit on /packages/app, one level above the first gap; none touch the second.
    const rows = text.split("\n").filter((line) => /^\| \d+ \| rg_/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.endsWith("| 1 |")).toBe(true);
    // Nothing open or closed, or a failed read: the atlas is byte-identical to one without gaps.
    clearKnowledgeMapCache();
    const empty = mapBackend({ knowledgeGapSummary: vi.fn(async () => ({ openScopes: [], closedLast30Days: 0 })) });
    const none = await knowledgeMapHandler(ctxWith(empty.backend), { workspace_id: WS, view: "atlas" });
    clearKnowledgeMapCache();
    const failing = mapBackend({ knowledgeGapSummary: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const failed = await knowledgeMapHandler(ctxWith(failing.backend), { workspace_id: WS, view: "atlas" });
    expect(none.ok && none.data.text).toBe(plain.ok && plain.data.text);
    expect(failed.ok && failed.data.text).toBe(plain.ok && plain.data.text);
  });

  it("pages a region and opens a sub-region id on its own page", async () => {
    const { backend } = mapBackend();
    const atlas = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "atlas" });
    const regionId = atlas.ok ? atlas.data.text!.match(/rg_[0-9a-f]{8}/)![0] : "";
    const page = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "region", region_id: regionId, purpose: "audit" });
    expect(page.ok && page.data).toMatchObject({ status: "ready", region_id: regionId, page: 1 });
    expect(page.ok && page.data.text).toContain("Audit checklist");
    const missing = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "region", region_id: "rg_00000000" });
    expect(!missing.ok && missing.error.code).toBe("not_found");
  });

  it("finds related knowledge by file", async () => {
    const { backend } = mapBackend();
    const out = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "related", files: ["packages/relay/src/replay.ts"] });
    expect(out.ok && out.data.related?.[0]).toMatchObject({ id: "anchor-mem", seed: true });
  });

  it("rejects incomplete arguments before touching the backend", async () => {
    const { backend, knowledgeMapFingerprint } = mapBackend();
    const region = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "region" });
    const related = await knowledgeMapHandler(ctxWith(backend), { workspace_id: WS, view: "related", query: " " });
    expect(!region.ok && region.error.code).toBe("invalid_args");
    expect(!related.ok && related.error.code).toBe("invalid_args");
    expect(knowledgeMapFingerprint).not.toHaveBeenCalled();
  });

  it("says unavailable for a backend without the optional map methods", async () => {
    const out = await knowledgeMapHandler(ctxWith({}), { workspace_id: WS, view: "atlas" });
    expect(out.ok && out.data.status).toBe("unavailable");
  });

  it("says computing when the first build misses the budget", async () => {
    const slow = mapBackend({ buildKnowledgeMapInput: vi.fn(() => new Promise<typeof input>((resolve) => setTimeout(() => resolve(input), 50))) });
    const out = await knowledgeMapHandler(ctxWith(slow.backend), { workspace_id: WS, view: "atlas" }, { budgetMs: 1 });
    expect(out.ok && out.data).toMatchObject({ status: "computing", retry_after_ms: 2000 });
  });

  it("returns a backend failure as an error, never as computing", async () => {
    const broken = mapBackend({ knowledgeMapFingerprint: vi.fn(async () => Promise.reject({ code: "42501", message: "access denied" })) });
    const out = await knowledgeMapHandler(ctxWith(broken.backend), { workspace_id: WS, view: "atlas" });
    expect(!out.ok && out.error.code).toBe("permission_denied");
  });

  it("keeps the tool description inside its always-listed budget", () => {
    expect(KNOWLEDGE_MAP_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(520);
  });
});
