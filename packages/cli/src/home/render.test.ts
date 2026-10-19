// SPDX-License-Identifier: Apache-2.0
// The home's words and numbers: compression only from an equivalent baseline, measured facts with
// their scope, and every other fact as words. Every layout fits its width, in colour or not, in
// Unicode or ASCII.
import { describe, expect, it } from "vitest";

import { terminalStyle } from "../terminal/style.js";
import { stripAnsi, visibleWidth } from "../terminal/text.js";
import {
  contextCompression,
  contextFacts,
  isFirstRun,
  loading,
  measured,
  unavailable,
  type ContextMeasurement,
  type HomeSnapshot,
} from "./facts.js";
import {
  attentionItems,
  busiestAreas,
  fitsCockpit,
  renderCockpit,
  type CockpitContext,
} from "./cockpit.js";
import { homeActions, renderActions, renderHome, type RenderContext } from "./render.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");

const base: ContextMeasurement = {
  representation: "markdown",
  tokens: 1000,
  tokenizer: "o200k_base",
  scope: "ws-1:/apps/api:request-7",
  contentDigest: "sha256:abc",
};

describe("context compression", () => {
  it("is measured only for the same knowledge, scope and tokenizer in two representations", () => {
    const result = contextCompression(base, { ...base, representation: "agent-ir", tokens: 400 });
    expect(result).toMatchObject({
      state: "measured",
      value: { baselineTokens: 1000, deliveredTokens: 400, ratio: 0.4, savedPercent: 60 },
    });
  });

  it("refuses all stored knowledge against a selected subset: that is selection, not compression", () => {
    const result = contextCompression(
      { ...base, tokens: 50_000, contentDigest: "sha256:all-knowledge" },
      { ...base, representation: "agent-ir", tokens: 400, contentDigest: "sha256:selected-3" },
    );
    expect(result.state).toBe("not_measured");
    expect(result.state === "not_measured" && result.reason).toMatch(/selection, not compression/);
  });

  it("refuses another tokenizer, another scope, one representation, or a missing count", () => {
    const delivered = { ...base, representation: "agent-ir", tokens: 400 };
    expect(contextCompression(base, { ...delivered, tokenizer: "cl100k_base" }).state).toBe(
      "not_measured",
    );
    expect(
      contextCompression(base, { ...delivered, scope: "ws-1:/apps/web:request-7" }).state,
    ).toBe("not_measured");
    expect(contextCompression(base, { ...delivered, representation: "markdown" }).state).toBe(
      "not_measured",
    );
    expect(contextCompression({ ...base, tokens: 0 }, delivered).state).toBe("not_measured");
    expect(contextCompression(null, delivered).state).toBe("not_measured");
    expect(contextCompression(base, null).state).toBe("not_measured");
  });

  it("reports a larger delivery as negative savings, never as compression", () => {
    const result = contextCompression(base, { ...base, representation: "agent-ir", tokens: 1200 });
    expect(result.state === "measured" && result.value.savedPercent).toBe(-20);
  });

  it("is not measured on a machine today, nor are delivered tokens or Agent IR size", () => {
    const facts = contextFacts();
    expect(facts.deliveredTokens.state).toBe("not_measured");
    expect(facts.agentIrTokens.state).toBe("not_measured");
    expect(facts.compression.state).toBe("not_measured");
  });
});

export function snapshotFixture(overrides: Partial<HomeSnapshot> = {}): HomeSnapshot {
  return {
    schema: 1,
    cliVersion: "0.6.1",
    cwd: "/Users/dev/code/app",
    workspace: {
      kind: "local",
      id: "ws-1",
      name: "app",
      root: "/Users/dev/code/app",
      relativePath: "",
      isProject: true,
    },
    intelligence: {
      mode: "local",
      chosenBy: "onboarding",
      capabilities: [],
      agentsMode: "local",
    },
    account: { applicable: false, state: "signed_out", detail: "Local needs no account." },
    integrations: {
      agents: [
        {
          id: "claude-code",
          name: "Claude Code",
          support: "native-plugin",
          detected: true,
          connections: [
            {
              scope: "user",
              projectRoot: null,
              mode: "local",
              channel: "native-plugin",
              status: "installed",
            },
          ],
        },
        { id: "codex", name: "Codex", support: "native-plugin", detected: true, connections: [] },
        {
          id: "cursor",
          name: "Cursor",
          support: "mcp-and-hooks-via-cli",
          detected: false,
          connections: [],
        },
      ],
      runtime: { version: "0.6.1", mode: "local", maintenance: true },
    },
    knowledge: measured(
      {
        memories: { active: 142, archived: 3 },
        rules: { active: 38, archived: 0 },
        skills: { active: 9, archived: 0 },
      },
      "local store",
    ),
    agentIr: measured(
      {
        approved: 12,
        proposed: 2,
        byKind: {
          remedy: { approved: 12, proposed: 2 },
          selection: { approved: 0, proposed: 0 },
          procedure: { approved: 0, proposed: 0 },
          context: { approved: 0, proposed: 0 },
          rationale: { approved: 0, proposed: 0 },
          precedence: { approved: 0, proposed: 0 },
        },
      },
      "local store",
    ),
    signals: measured(
      { groups: 4, active: 1, declared: 0, lastSeen: "2026-10-10T10:00:00Z" },
      "local store",
    ),
    activity: measured(
      [{ at: "2026-10-10T10:00:00Z", path: "/packages/cli", summary: "Added the terminal home" }],
      "activity log",
    ),
    deliveries: measured(
      {
        sessions: 87,
        items: 1204,
        byChannel: { hook: 900, mcp: 304 },
        byKind: { memory: 1000, rule: 204 },
        lastAt: "2026-10-10T11:56:00Z",
        hourly: [0, 0, 1, 0, 3, 5, 9, 7, 4, 2, 0, 0, 0, 0, 1, 6, 12, 8, 3, 0, 0, 2, 4, 1],
        sessionsRead: 50,
        sessionsTotal: 87,
      },
      "ledgers",
    ),
    paths: measured(
      [
        { path: "/", memories: 4, rules: 3, skills: 0 },
        { path: "/packages/cli", memories: 20, rules: 6, skills: 2 },
        { path: "/packages/cli/src/home", memories: 3, rules: 0, skills: 0 },
        { path: "/packages/host", memories: 15, rules: 4, skills: 0 },
        { path: "/docs", memories: 7, rules: 0, skills: 1 },
      ],
      "local store",
    ),
    refreshes: measured(3, "local store"),
    context: contextFacts(),
    ...overrides,
  };
}

function ctx(columns: number, color = true, unicode = true, compact = false): RenderContext {
  return {
    style: terminalStyle({ color, unicode }),
    columns,
    now: NOW,
    homeDir: "/Users/dev",
    compact,
  };
}

describe("the home", () => {
  for (const columns of [32, 59, 79, 99, 120]) {
    it(`fits ${columns} columns`, () => {
      for (const c of [ctx(columns), ctx(columns, false, false)]) {
        const lines = [
          ...renderHome(snapshotFixture(), c),
          ...renderActions(homeActions(snapshotFixture()), 0, c),
        ];
        expect(lines.filter((line) => visibleWidth(line) > columns).map(stripAnsi)).toEqual([]);
      }
    });
  }

  it("shows measured numbers with their scope, and the unmeasured as words", () => {
    const text = stripAnsi(renderHome(snapshotFixture(), ctx(100)).join("\n"));
    expect(text).toContain("Memories   142");
    expect(text).toContain("3 archived");
    expect(text).toContain("Verified   12");
    expect(text).toContain("Candidates 2");
    expect(text).toContain("1,204");
    expect(text).toContain("87 agent sessions");
    expect(text).toContain("newest 50 of 87 sessions read");
    expect(text).toMatch(/Delivered tokens\s+not measured/);
    expect(text).toMatch(/Compression\s+not measured/);
    expect(text).toContain("logged by agents, not verified");
    expect(text).not.toMatch(/%/);
  });

  it("says reading while the store loads, and never shows a zero for what it could not read", () => {
    const pending = snapshotFixture({
      knowledge: loading(),
      agentIr: unavailable("The running Pathrule host predates Agent IR atoms."),
      deliveries: unavailable("The ledgers could not be read: EACCES"),
    });
    const text = stripAnsi(renderHome(pending, ctx(80)).join("\n"));
    expect(text).toContain("reading…");
    expect(text).toContain("unavailable · The running Pathrule host predates Agent IR atoms.");
    expect(text).not.toMatch(/Memories\s+0/);
    expect(text).not.toMatch(/Verified\s+0/);
  });

  it("shows compression only when it was measured from an equivalent baseline", () => {
    const measuredContext = {
      ...contextFacts(),
      compression: contextCompression(base, { ...base, representation: "agent-ir", tokens: 400 }),
    };
    const text = stripAnsi(
      renderHome(snapshotFixture({ context: measuredContext }), ctx(100)).join("\n"),
    );
    expect(text).toContain("60% smaller (400 of 1,000 tokens, o200k_base)");
  });

  it("uses no colour escapes without colour and only ASCII without Unicode", () => {
    const lines = [
      ...renderHome(snapshotFixture(), ctx(80, false, false)),
      ...renderActions(homeActions(snapshotFixture()), 2, ctx(80, false, false)),
    ];
    const text = lines.join("\n");
    expect(text).not.toContain("\x1b[");
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(text).toContain("[c Console]");
  });

  it("says when agents still use the other mode, and when Cloud is not signed in", () => {
    const cloud = snapshotFixture({
      intelligence: {
        mode: "cloud",
        chosenBy: "onboarding",
        capabilities: [],
        agentsMode: "local",
      },
      account: {
        applicable: true,
        state: "signed_out",
        detail: "The stored session is no longer valid (expired or revoked). Sign in again.",
      },
    });
    const text = stripAnsi(renderHome(cloud, ctx(100)).join("\n"));
    expect(text).toContain("not signed in");
    expect(text).toContain("expired or revoked");
    expect(text).toContain("Your agents still use Local; re-point them with Mode (m).");
    expect(homeActions(cloud).map((a) => a.id)).toContain("sign-in");
    expect(homeActions(cloud).map((a) => a.id)).not.toContain("model");
  });

  it("compacts context and drops activity on a short terminal", () => {
    const full = renderHome(snapshotFixture(), ctx(80));
    const compact = renderHome(snapshotFixture(), ctx(80, true, true, true));
    expect(compact.length).toBeLessThan(full.length);
    expect(stripAnsi(compact.join("\n"))).toContain(
      "tokens, Agent IR size and compression: not measured",
    );
  });
});

describe("first run", () => {
  it("is a machine with no mode and no connected agent", () => {
    const fresh = snapshotFixture({
      intelligence: { mode: "unset", chosenBy: null, capabilities: [], agentsMode: null },
      integrations: {
        agents: [
          { id: "codex", name: "Codex", support: "native-plugin", detected: true, connections: [] },
        ],
        runtime: null,
      },
    });
    expect(isFirstRun(fresh)).toBe(true);
    expect(isFirstRun(snapshotFixture())).toBe(false);
  });
});

function cockpitCtx(columns: number, rows: number, color = true, unicode = true): CockpitContext {
  return {
    style: terminalStyle({ color, unicode, depth: "truecolor", tone: "dark" }),
    columns,
    rows,
    now: NOW,
    homeDir: "/Users/dev",
  };
}

describe("the cockpit", () => {
  const sizes: Array<[number, number]> = [
    [80, 22],
    [100, 30],
    [120, 40],
    [160, 50],
  ];
  for (const [columns, rows] of sizes) {
    it(`fills ${columns}×${rows} exactly, in colour or not, in Unicode or ASCII`, () => {
      for (const c of [cockpitCtx(columns, rows), cockpitCtx(columns, rows, false, false)]) {
        const lines = renderCockpit(
          snapshotFixture(),
          homeActions(snapshotFixture()),
          { focus: "knowledge" },
          c,
        );
        expect(lines).toHaveLength(rows);
        expect(lines.filter((line) => visibleWidth(line) > columns).map(stripAnsi)).toEqual([]);
      }
    });
  }

  it("lays out only where it fits; smaller terminals get the linear home", () => {
    expect(fitsCockpit(80, 22)).toBe(true);
    expect(fitsCockpit(79, 40)).toBe(false);
    expect(fitsCockpit(120, 21)).toBe(false);
  });

  it("shows what the workspace holds and where, who is connected, what reached the agents", () => {
    const text = stripAnsi(
      renderCockpit(
        snapshotFixture(),
        homeActions(snapshotFixture()),
        { focus: "knowledge" },
        cockpitCtx(120, 40),
      ).join("\n"),
    );
    expect(text).toContain("142 memories   38 rules   9 skills");
    expect(text).toContain("3 archived");
    // The busiest areas, grouped to two segments: /packages/cli holds 28 + 3 below it.
    expect(text).toMatch(/packages\/cli +█+░* +31/);
    expect(text).toMatch(/packages\/host +█+░* +19/);
    expect(text).toContain("Claude Code");
    expect(text).toContain("found · a connects");
    expect(text).toContain("1,204 items in 87 sessions · last 4 min ago");
    expect(text).toContain("hook 900 · MCP 304 · newest 50 of 87 sessions");
    expect(text).toContain("3 refresh tasks waiting");
    expect(text).toContain("2 knowledge atoms to review");
    expect(text).toContain("Added the terminal home");
    expect(text).toContain("logged by agents, not verified");
  });

  it("groups paths to their first two segments, busiest first", () => {
    expect(
      busiestAreas([
        { path: "/", memories: 1, rules: 0, skills: 0 },
        { path: "/a/b/c", memories: 2, rules: 0, skills: 0 },
        { path: "/a/b", memories: 1, rules: 1, skills: 0 },
        { path: "/z", memories: 0, rules: 0, skills: 0 },
      ]),
    ).toEqual([
      { area: "/a/b", items: 4 },
      { area: "/", items: 1 },
    ]);
  });

  it("says reading while the store loads, and never shows a zero for what it could not read", () => {
    const text = stripAnsi(
      renderCockpit(
        snapshotFixture({
          knowledge: loading(),
          paths: loading(),
          activity: unavailable("No Pathrule workspace serves this folder yet."),
          deliveries: loading(),
          refreshes: loading(),
        }),
        homeActions(snapshotFixture()),
        { focus: "agents" },
        cockpitCtx(100, 30),
      ).join("\n"),
    );
    expect(text).toContain("reading…");
    expect(text).toContain("No Pathrule workspace serves this folder yet.");
    expect(text).not.toMatch(/\b0 memories\b/);
    expect(text).not.toContain("refresh task");
  });

  it("lists what needs the person, and says so when nothing does", () => {
    const settled = snapshotFixture({
      refreshes: measured(0, "local store"),
      agentIr: measured(
        {
          approved: 1,
          proposed: 0,
          byKind: {
            remedy: { approved: 1, proposed: 0 },
            selection: { approved: 0, proposed: 0 },
            procedure: { approved: 0, proposed: 0 },
            context: { approved: 0, proposed: 0 },
            rationale: { approved: 0, proposed: 0 },
            precedence: { approved: 0, proposed: 0 },
          },
        },
        "local store",
      ),
    });
    expect(attentionItems(settled)).toEqual([]);
    const text = stripAnsi(
      renderCockpit(
        settled,
        homeActions(settled),
        { focus: "attention" },
        cockpitCtx(100, 30),
      ).join("\n"),
    );
    expect(text).toContain("Nothing needs you.");
    const cloudSignedOut = snapshotFixture({
      intelligence: {
        mode: "cloud",
        chosenBy: "onboarding",
        capabilities: [],
        agentsMode: "local",
      },
      account: { applicable: true, state: "signed_out", detail: "Not signed in." },
    });
    const texts = attentionItems(cloudSignedOut).map((item) => item.text);
    expect(texts).toContain("Not signed in to Pathrule Cloud");
    expect(texts).toContain("Agents still use Local");
  });

  it("uses no colour escapes without colour and only ASCII without Unicode", () => {
    const lines = renderCockpit(
      snapshotFixture(),
      homeActions(snapshotFixture()),
      { focus: "knowledge" },
      cockpitCtx(100, 30, false, false),
    );
    const text = lines.join("\n");
    expect(text).not.toContain("\x1b[");
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("never drops an action's key from the key bar, whatever the width", () => {
    const cloud = snapshotFixture({
      intelligence: {
        mode: "cloud",
        chosenBy: "onboarding",
        capabilities: [],
        agentsMode: "cloud",
      },
      account: { applicable: true, state: "signed_out", detail: "Not signed in." },
    });
    const actions = homeActions(cloud);
    for (const columns of [80, 100, 160]) {
      for (const c of [cockpitCtx(columns, 30), cockpitCtx(columns, 30, false, false)]) {
        const bar = stripAnsi(renderCockpit(cloud, actions, { focus: "knowledge" }, c).at(-1)!);
        expect(visibleWidth(bar)).toBeLessThanOrEqual(columns);
        // Each key as a key cap: " k " in colour, "[k]" without.
        for (const action of actions) {
          expect(bar).toContain(c.style.color ? ` ${action.key} ` : `[${action.key}]`);
        }
      }
    }
  });

  it("puts a notice in place of the key hints", () => {
    const lines = renderCockpit(
      snapshotFixture(),
      homeActions(snapshotFixture()),
      { focus: "knowledge", notice: 'No action on "z".' },
      cockpitCtx(100, 30),
    );
    expect(stripAnsi(lines[lines.length - 1]!)).toBe('No action on "z".');
  });
});
