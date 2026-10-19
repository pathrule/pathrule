// SPDX-License-Identifier: Apache-2.0
// Tests for selectInjectedRules + session memo + TTL eviction

import { describe, it, expect, beforeEach } from "vitest";
import {
  selectInjectedRules,
  SESSION_IDLE_TTL_MS,
  __resetSessionRuleMemoForTests,
  __advanceSessionTimestampsForTests,
  __getSessionMemoSizeForTests,
} from "./select-injected-rules.js";
import type { CandidateRule } from "@pathrule/protocol/hook-index.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRule(
  id: string,
  strategy: CandidateRule["injection_strategy"] = "per_call",
): CandidateRule {
  return {
    rule_id: id,
    workspace_id: "ws-test",
    name: `Rule ${id}`,
    body: "rule body",
    scope_type: "project",
    priority: "medium",
    injection_strategy: strategy,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("selectInjectedRules", () => {
  beforeEach(() => {
    __resetSessionRuleMemoForTests();
  });

  // ── Feature flag OFF ────────────────────────────────────────────────────────

  it("flag-off: claude_md_only rules still appear in injected (per_call behaviour)", () => {
    const input = {
      session_id: "s1",
      candidates: [
        makeRule("r1", "per_call"),
        makeRule("r2", "claude_md_only"),
        makeRule("r3", "session_once"),
      ],
      promotion_enabled: false,
    };
    const { injected, breakdown } = selectInjectedRules(input);
    expect(injected).toHaveLength(3);
    expect(breakdown.per_call).toBe(3);
    expect(breakdown.claude_md_only_skipped).toBe(0);
    expect(breakdown.session_once).toBe(0);
  });

  // ── per_call (flag ON) ──────────────────────────────────────────────────────

  it("flag-on, per_call: every event includes the rule", () => {
    const rule = makeRule("r1", "per_call");
    const base = { session_id: "s1", candidates: [rule], promotion_enabled: true };

    const r1 = selectInjectedRules(base);
    const r2 = selectInjectedRules(base);
    expect(r1.injected).toHaveLength(1);
    expect(r2.injected).toHaveLength(1);
    expect(r1.breakdown.per_call).toBe(1);
    expect(r2.breakdown.per_call).toBe(1);
  });

  // ── session_once (flag ON) ──────────────────────────────────────────────────

  it("flag-on, session_once: first event includes, second skips, different session includes again", () => {
    const rule = makeRule("r1", "session_once");

    // First call — same session
    const r1 = selectInjectedRules({
      session_id: "s1",
      candidates: [rule],
      promotion_enabled: true,
    });
    expect(r1.injected).toHaveLength(1);
    expect(r1.breakdown.session_once).toBe(1);
    expect(r1.breakdown.session_once_skipped).toBe(0);

    // Second call — same session (should skip)
    const r2 = selectInjectedRules({
      session_id: "s1",
      candidates: [rule],
      promotion_enabled: true,
    });
    expect(r2.injected).toHaveLength(0);
    expect(r2.breakdown.session_once_skipped).toBe(1);
    expect(r2.breakdown.session_once).toBe(0);

    // Different session — should inject again
    const r3 = selectInjectedRules({
      session_id: "s2",
      candidates: [rule],
      promotion_enabled: true,
    });
    expect(r3.injected).toHaveLength(1);
    expect(r3.breakdown.session_once).toBe(1);
  });

  // ── claude_md_only (flag ON) ────────────────────────────────────────────────

  it("flag-on, claude_md_only: never in injected", () => {
    const rule = makeRule("r1", "claude_md_only");
    const r = selectInjectedRules({
      session_id: "s1",
      candidates: [rule],
      promotion_enabled: true,
    });
    expect(r.injected).toHaveLength(0);
    expect(r.breakdown.claude_md_only_skipped).toBe(1);
  });

  // ── TTL eviction ────────────────────────────────────────────────────────────

  it("TTL eviction: advancing clock by >30min causes session_once rule to re-inject", () => {
    const rule = makeRule("r1", "session_once");

    // First inject — memoises r1 for session s1.
    selectInjectedRules({ session_id: "s1", candidates: [rule], promotion_enabled: true });

    // Advance timestamps by 31 minutes — exceeds idle TTL.
    __advanceSessionTimestampsForTests(SESSION_IDLE_TTL_MS + 60_000);

    // Trigger eviction by calling again (evictIdleSessions runs at top of selectInjectedRules).
    const r2 = selectInjectedRules({
      session_id: "s1",
      candidates: [rule],
      promotion_enabled: true,
    });

    // Session was evicted → treated as new → rule re-injects.
    expect(r2.injected).toHaveLength(1);
    expect(r2.breakdown.session_once).toBe(1);
  });

  // ── Concurrent sessions ─────────────────────────────────────────────────────

  it("concurrent sessions: each gets its own memo bucket", () => {
    const rule = makeRule("r1", "session_once");

    selectInjectedRules({ session_id: "claude-1", candidates: [rule], promotion_enabled: true });
    selectInjectedRules({ session_id: "cursor-1", candidates: [rule], promotion_enabled: true });

    // Both sessions now have the rule memoised.
    const claudeSecond = selectInjectedRules({
      session_id: "claude-1",
      candidates: [rule],
      promotion_enabled: true,
    });
    const cursorSecond = selectInjectedRules({
      session_id: "cursor-1",
      candidates: [rule],
      promotion_enabled: true,
    });

    expect(claudeSecond.injected).toHaveLength(0);
    expect(cursorSecond.injected).toHaveLength(0);
    expect(__getSessionMemoSizeForTests()).toBe(2);
  });

  // ── Breakdown accuracy ──────────────────────────────────────────────────────

  it("breakdown sums equal candidate count", () => {
    const candidates: CandidateRule[] = [
      makeRule("r1", "per_call"),
      makeRule("r2", "per_call"),
      makeRule("r3", "session_once"),
      makeRule("r4", "session_once"),
      makeRule("r5", "claude_md_only"),
      makeRule("r6", "claude_md_only"),
      makeRule("r7", "claude_md_only"),
    ];

    // First call: all session_once rules fire.
    const r1 = selectInjectedRules({ session_id: "s1", candidates, promotion_enabled: true });
    const total1 =
      r1.breakdown.per_call +
      r1.breakdown.session_once +
      r1.breakdown.session_once_skipped +
      r1.breakdown.claude_md_only_skipped;
    expect(total1).toBe(candidates.length);

    // Second call: session_once rules are skipped now.
    const r2 = selectInjectedRules({ session_id: "s1", candidates, promotion_enabled: true });
    const total2 =
      r2.breakdown.per_call +
      r2.breakdown.session_once +
      r2.breakdown.session_once_skipped +
      r2.breakdown.claude_md_only_skipped;
    expect(total2).toBe(candidates.length);
    expect(r2.breakdown.session_once_skipped).toBe(2);
  });
});
