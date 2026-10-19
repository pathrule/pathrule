// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { cluster, item, workspace } from "./__fixtures__/workspace.js";
import { buildKnowledgeMap } from "./build.js";
import { RELATED_TO_CHECK_MAX_CHARS, createWriteHintLedger, relatedToCheck } from "./write-hint.js";

const text = "orbit relay must replay the cursor after reconnect before streaming envelopes";
const map = buildKnowledgeMap(
  workspace(
    [
      {
        items: [
          item("c-rule", "Replay before streaming", text, "/packages/relay", "rule"),
          item("c-skill", "relay-replay", text, "/packages/relay", "skill"),
          item("c-mem", "Relay replay ordering", text, "/packages/relay", "memory"),
        ],
      },
      cluster({ prefix: "pay", size: 12, path: "/p", words: ["invoice", "charge", "refund"] }),
      cluster({ prefix: "font", size: 12, path: "/q", words: ["glyph", "kerning", "typeface"] }),
    ],
    { semantic: "lexical", neighbours: [] },
  ),
  { fingerprint: "fp", generatedAt: "2026-10-01T00:00:00.000Z" },
);

describe("relatedToCheck", () => {
  it("names a rule's companion skill and memory after it is updated", () => {
    const hint = relatedToCheck(map, "c-rule");
    expect(hint.map((h) => h.id).sort()).toEqual(["c-mem", "c-skill"]);
    expect(hint.every((h) => h.reason.includes("same change"))).toBe(true);
    expect(JSON.stringify(hint).length).toBeLessThanOrEqual(RELATED_TO_CHECK_MAX_CHARS);
  });

  it("names linked items and nothing weaker", () => {
    const hint = relatedToCheck(map, "pay-000");
    expect(hint.length).toBeLessThanOrEqual(3);
    expect(hint.every((h) => h.reason === "links with this item" || h.reason.startsWith("near duplicate"))).toBe(true);
  });

  it("says nothing without a cached map or for an unknown item", () => {
    expect(relatedToCheck(null, "c-rule")).toEqual([]);
    expect(relatedToCheck(map, "nope")).toEqual([]);
  });

  it("tells a session once per item", () => {
    const once = createWriteHintLedger();
    expect(once("ws", "c-rule", map)).toHaveLength(2);
    expect(once("ws", "c-rule", map)).toEqual([]);
    expect(once("ws", "c-skill", map).length).toBeGreaterThan(0);
  });
});
