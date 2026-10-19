// SPDX-License-Identifier: Apache-2.0
// Team context block: budget, determinism, and the structural guarantee that
// nothing evaluative can travel in it.
import { describe, expect, it } from "vitest";
import {
  TEAM_BLOCK_TOKEN_BUDGET,
  TEAM_CONTEXT_HEADING,
  estimateBlockTokens,
  renderTeamContextBlock,
  type TeamContextBlock,
} from "./team-context-block.js";

const FULL: TeamContextBlock = {
  teamName: "Atolye15",
  userName: "Sertan",
  userAreas: ["frontend", "ui-ux"],
  owners: [
    { name: "Alperen", area: "/packages/api" },
    { name: "Oguz", area: "/packages/web" },
  ],
  decisionOwners: [{ name: "Oguz", scope: "product" }],
};

describe("renderTeamContextBlock", () => {
  it("renders one block with the heading, the people, and the guidance", () => {
    const out = renderTeamContextBlock(FULL);
    expect(out).not.toBeNull();
    expect(out).toContain(TEAM_CONTEXT_HEADING);
    expect(out).toContain("Team: Atolye15.");
    expect(out).toContain("User: Sertan (frontend, ui-ux).");
    expect(out).toContain("Alperen (/packages/api)");
    expect(out).toContain("Declared decision scope: Oguz (product).");
    expect(out).toContain("point at its owner instead of deciding for them.");
    // One block, never two.
    expect(out!.split(TEAM_CONTEXT_HEADING).length - 1).toBe(1);
  });

  it("stays inside the 120 token budget", () => {
    const out = renderTeamContextBlock(FULL);
    expect(estimateBlockTokens(out!)).toBeLessThanOrEqual(TEAM_BLOCK_TOKEN_BUDGET);
  });

  it("stays inside the budget with the maximum shape the fields allow", () => {
    const long = "x".repeat(200);
    const out = renderTeamContextBlock({
      teamName: long,
      userName: long,
      userAreas: [long, long, long, long, long],
      owners: Array.from({ length: 12 }, (_, i) => ({ name: `${long}${i}`, area: long })),
      decisionOwners: Array.from({ length: 6 }, (_, i) => ({ name: `${long}${i}`, scope: long })),
    });
    expect(out).not.toBeNull();
    expect(estimateBlockTokens(out!)).toBeLessThanOrEqual(TEAM_BLOCK_TOKEN_BUDGET);
  });

  it("drops whole lines from the low-value end rather than truncating a sentence", () => {
    // Long area labels: the identity line fits, the rest cannot.
    const out = renderTeamContextBlock({
      teamName: "Atolye15",
      userName: "Sertan",
      owners: Array.from({ length: 3 }, (_, i) => ({
        name: `Person${i}`,
        area: "/a/very/long/workspace/relative/path/segment",
      })),
      decisionOwners: [{ name: "Oguz", scope: "product and platform decisions overall" }],
    });
    expect(out).not.toBeNull();
    expect(out).toContain("Team: Atolye15.");
    // Whatever was dropped, no line is left half-written.
    for (const line of out!.trim().split("\n")) {
      if (line.length === 0 || line.startsWith("#")) continue;
      expect(line.endsWith(".")).toBe(true);
    }
    expect(estimateBlockTokens(out!)).toBeLessThanOrEqual(TEAM_BLOCK_TOKEN_BUDGET);
  });

  it("is byte-identical across calls and independent of input order", () => {
    const a = renderTeamContextBlock(FULL);
    const b = renderTeamContextBlock({
      ...FULL,
      owners: [...FULL.owners!].reverse(),
    });
    expect(a).toBe(b);
    expect(renderTeamContextBlock(FULL)).toBe(a);
  });

  it("suppresses the block when there is nobody to point at", () => {
    expect(renderTeamContextBlock(null)).toBeNull();
    expect(renderTeamContextBlock(undefined)).toBeNull();
    expect(renderTeamContextBlock({})).toBeNull();
    // Guidance alone is noise: an instruction with no owner is suppressed.
    expect(renderTeamContextBlock({ owners: [], decisionOwners: [] })).toBeNull();
  });

  it("renders from the user alone when no other member is known yet", () => {
    const out = renderTeamContextBlock({ teamName: "Atolye15", userName: "Sertan" });
    expect(out).toContain("Team: Atolye15. User: Sertan.");
    expect(out).not.toContain("Reference for each area");
  });

  it("collapses free text so a compiled file cannot grow a paragraph", () => {
    const out = renderTeamContextBlock({
      teamName: "Atolye15",
      userName: "Sertan",
      owners: [{ name: "Alperen\nis slow at reviews", area: "/api\n\nmore prose" }],
    });
    expect(out).not.toBeNull();
    // The injected newlines are gone: every rendered line is one sentence frame.
    expect(out!.split("\n").filter((l) => l.includes("is slow at reviews")).length).toBeLessThanOrEqual(1);
    expect(out).not.toContain("\n\nmore prose");
  });

  it("drops an owner with a missing name or area instead of rendering a half entry", () => {
    const out = renderTeamContextBlock({
      userName: "Sertan",
      owners: [
        { name: "Alperen", area: "" },
        { name: "   ", area: "/api" },
        { name: "Oguz", area: "/web" },
      ],
    });
    expect(out).toContain("Reference for each area: Oguz (/web).");
    expect(out).not.toContain("Alperen");
  });

  it("de-duplicates and caps the named owners", () => {
    const out = renderTeamContextBlock({
      userName: "Sertan",
      owners: [
        { name: "A", area: "/a" },
        { name: "A", area: "/a" },
        { name: "B", area: "/b" },
        { name: "C", area: "/c" },
        { name: "D", area: "/d" },
      ],
    });
    expect(out).toContain("A (/a), B (/b), C (/c).");
    expect(out).not.toContain("D (/d)");
  });
});
