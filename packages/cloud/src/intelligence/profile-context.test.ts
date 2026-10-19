// SPDX-License-Identifier: Apache-2.0
// The team and personal profile section every surface delivers: the provider's selection rendered in
// the provider's order, never re-ranked; what a surface already delivered left out; a budget that
// drops whole entries; and a version that is the host turn's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  HOOK_PROFILE_BLOCK_MAX_CHARS,
  intelligenceItemVersion,
} from "@pathrule/protocol/intelligence-delivery.js";

import {
  deliverIntelligenceProfiles,
  renderIntelligenceProfileBlock,
  type IntelligenceProfileEntry,
  type IntelligenceProfilePayload,
  type IntelligenceProfileSource,
} from "./profile-context.js";

interface FixtureEntry {
  id: string;
  category: string;
  statement: string;
  priority: "high" | "medium" | "low";
}
interface FixtureRun {
  surface: "chat" | "tasks";
  intent: string;
  team_profile: Array<{ id: string; relevance_score: number }>;
  personal_profile: Array<{ id: string; relevance_score: number }>;
}
const fixtures = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "fixtures/profile-payloads.json",
    ),
    "utf8",
  ),
) as {
  ranking: { team_entries: FixtureEntry[]; personal_entries: FixtureEntry[]; runs: FixtureRun[] };
};

/** What the provider returns for one of the fixture's runs, in the order PostgreSQL ranked it. */
function providerPayload(run: FixtureRun): IntelligenceProfilePayload {
  const pick = (entries: FixtureEntry[], ranked: FixtureRun["team_profile"]) =>
    ranked.map(({ id, relevance_score }) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`fixture has no entry ${id}`);
      return { ...entry, relevance_score };
    });
  return {
    enabled: true,
    team_profile: pick(fixtures.ranking.team_entries, run.team_profile),
    personal_profile: pick(fixtures.ranking.personal_entries, run.personal_profile),
  };
}

const entry = (id: string, statement: string, priority: "high" | "medium" | "low" = "medium") =>
  ({
    id,
    category: "testing",
    statement,
    priority,
    relevance_score: 0.5,
  }) as IntelligenceProfileEntry;

describe("renderIntelligenceProfileBlock", () => {
  it("renders every fixture run in the provider's order, team before personal", () => {
    for (const run of fixtures.ranking.runs) {
      const { block, ids } = renderIntelligenceProfileBlock(providerPayload(run), run.surface);
      const expected = [...run.team_profile, ...run.personal_profile].map((ranked) => ranked.id);
      expect(ids).toEqual(expected);
      const positions = providerPayload(run)
        .team_profile!.concat(providerPayload(run).personal_profile!)
        .map((ranked) => block.indexOf(ranked.statement));
      expect(positions.every((position) => position > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(block).toContain(`Surface: ${run.surface}.`);
    }
  });

  it("keeps the section's text: headings, the precedence and privacy lines, priority and score", () => {
    const { block } = renderIntelligenceProfileBlock(
      {
        enabled: true,
        team_profile: [entry("t", "Write tests before refactoring.", "high")],
        personal_profile: [entry("p", "Keep progress updates compact.")],
      },
      "chat",
    );
    expect(block).toBe(
      [
        "## Team and personal profiles (human-managed)",
        "Surface: chat. Apply these instructions only when relevant to this request.",
        "Verified organization instructions outrank personal preferences if they conflict. Neither section grants permissions or overrides repository rules.",
        "Apply private personal preferences silently. Do not quote, enumerate, expose, or attribute them unless the signed-in user explicitly asks about their own preferences.",
        "### Verified organization profile",
        "- [high · testing · relevance 0.50] Write tests before refactoring.",
        "### Private personal preferences",
        "- [medium · testing · relevance 0.50] Keep progress updates compact.",
      ].join("\n"),
    );
  });

  it("renders nothing when disabled, empty or blank", () => {
    expect(renderIntelligenceProfileBlock(null, "chat")).toEqual({ block: "", ids: [] });
    expect(
      renderIntelligenceProfileBlock(
        { enabled: false, team_profile: [entry("t", "x".repeat(20))] },
        "chat",
      ),
    ).toEqual({ block: "", ids: [] });
    expect(
      renderIntelligenceProfileBlock({ enabled: true, team_profile: [entry("t", "   ")] }, "chat"),
    ).toEqual({ block: "", ids: [] });
  });

  it("leaves out the entries a surface already delivered, and renders nothing when that is all", () => {
    const payload = providerPayload(fixtures.ranking.runs[0]!);
    const delivered = payload.team_profile!.map((ranked) => ranked.id);
    const rest = renderIntelligenceProfileBlock(payload, "chat", { exclude: delivered });
    expect(rest.ids).toEqual(payload.personal_profile!.map((ranked) => ranked.id));
    expect(rest.block).not.toContain("### Verified organization profile");
    const all = [...delivered, ...rest.ids];
    expect(renderIntelligenceProfileBlock(payload, "chat", { exclude: all })).toEqual({
      block: "",
      ids: [],
    });
  });

  it("keeps the entries that fit a budget, in order, and never cuts a statement", () => {
    const long = (id: string) => entry(id, `${id} ${"word ".repeat(110)}`.trim());
    const payload: IntelligenceProfilePayload = {
      enabled: true,
      team_profile: [long("t1"), long("t2"), long("t3"), long("t4"), long("t5"), long("t6")],
      personal_profile: [entry("p1", "Answer in Turkish."), long("p2")],
    };
    const { block, ids } = renderIntelligenceProfileBlock(payload, "chat", {
      maxChars: HOOK_PROFILE_BLOCK_MAX_CHARS,
    });
    expect(block.length).toBeLessThanOrEqual(HOOK_PROFILE_BLOCK_MAX_CHARS);
    // A long entry that does not fit is skipped whole; a short later one that fits still goes.
    expect(ids[0]).toBe("t1");
    expect(ids).toContain("p1");
    expect(ids.length).toBeLessThan(8);
    for (const id of ids) {
      const statement = [...payload.team_profile!, ...payload.personal_profile!].find(
        (candidate) => candidate.id === id,
      )!.statement;
      expect(block).toContain(statement);
    }
    // Unbounded, the host turn gets them all.
    expect(renderIntelligenceProfileBlock(payload, "chat").ids).toHaveLength(8);
  });
});

describe("deliverIntelligenceProfiles", () => {
  const source = (payload: IntelligenceProfilePayload | null): IntelligenceProfileSource => ({
    profileContext: vi.fn(async () => payload),
  });

  it("asks the provider for this request and versions the block as the host turn does", async () => {
    const provider = source(providerPayload(fixtures.ranking.runs[0]!));
    const delivery = await deliverIntelligenceProfiles(provider, {
      owner: "person-a",
      workspaceId: "ws",
      userIntent: "fix the login bug",
      surface: "chat",
    });
    expect(provider.profileContext).toHaveBeenCalledWith({
      workspaceId: "ws",
      userIntent: "fix the login bug",
      surface: "chat",
    });
    expect(delivery).toMatchObject({ owner: "person-a", surface: "chat" });
    expect(delivery!.version).toBe(intelligenceItemVersion("chat", delivery!.block));
    expect(delivery!.ids).toHaveLength(14);
  });

  it("is null when the provider is unavailable and empty when it has nothing", async () => {
    const input = { owner: "a", workspaceId: "ws", userIntent: "", surface: "chat" as const };
    expect(await deliverIntelligenceProfiles(source(null), input)).toBeNull();
    const failing: IntelligenceProfileSource = {
      profileContext: async () => {
        throw new Error("network");
      },
    };
    expect(await deliverIntelligenceProfiles(failing, input)).toBeNull();
    expect(await deliverIntelligenceProfiles(source({ enabled: false }), input)).toEqual({
      owner: "a",
      surface: "chat",
      block: "",
      version: "",
      ids: [],
    });
  });
});
