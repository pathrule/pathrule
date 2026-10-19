// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { clearKnowledgeMapCache, loadKnowledgeMap } from "@pathrule/core/knowledge-map/cache.js";
import type { KnowledgeMap } from "@pathrule/core/knowledge-map/types.js";
import { relatedToCheckField } from "../lib/write-hint.js";

const map = {
  algorithm: "m202.v1",
  workspaceId: "ws-hint",
  fingerprint: "fp",
  generatedAt: "",
  semantic: "lexical",
  items: {
    r: { id: "r", kind: "rule", title: "Rule", nodePaths: ["/"], oneLiner: "", tokens: 1, updatedAt: "", anchors: [], regionId: null, subRegionId: null, loose: false, sessions: null },
    s: { id: "s", kind: "skill", title: "Skill", nodePaths: ["/"], oneLiner: "", tokens: 1, updatedAt: "", anchors: [], regionId: null, subRegionId: null, loose: false, sessions: null },
  },
  edges: [{ a: "r", b: "s", weight: 0.9, kinds: ["semantic"], similarity: 0.95 }],
  regions: [],
  conventions: [],
  findings: [],
  links: { resolved: 0, byStage: { exact: 0, apostrophe: 0, punctuation: 0, prefix: 0, subset: 0 }, dangling: 0 },
} as unknown as KnowledgeMap;

afterEach(() => clearKnowledgeMapCache());

describe("related_to_check on update responses", () => {
  it("adds nothing when no map is cached, so the response stays byte-identical", () => {
    expect(relatedToCheckField("ws-hint", "r")).toEqual({});
  });

  it("adds the hint from a cached map once per item per session", async () => {
    await loadKnowledgeMap({ workspaceId: "ws-hint", fingerprint: "fp", build: async () => map });
    expect(relatedToCheckField("ws-hint", "r")).toEqual({
      related_to_check: [{ id: "s", kind: "skill", title: "Skill", reason: "says the same as this rule; it may need the same change" }],
    });
    expect(relatedToCheckField("ws-hint", "r")).toEqual({});
  });
});
