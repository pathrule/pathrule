// SPDX-License-Identifier: Apache-2.0
// SelectInjectedRules: per-rule injection strategy filter
//
// The hot path for hook payload assembly. Three behaviours:
//   per_call        — always inject the rule (default, flag-agnostic).
//   session_once    — inject once per session via in-process Map memo;
//                     30-min idle TTL evicts stale sessions.
//   claude_md_only  — never inject; rule lives in the rendered instructions
//                     file (CLAUDE.md / .cursorrules / AGENTS.md / .windsurfrules).
//
// With promotion_enabled=false (feature flag off) every rule behaves as
// per_call regardless of the stored injection_strategy.

import type {
  CandidateRule,
  SelectInjectedRulesInput,
  SelectInjectedRulesOutput,
} from "@pathrule/protocol/hook-index.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-process session memo (not durable state)
// ─────────────────────────────────────────────────────────────────────────────

interface SessionRuleMemo {
  rules: Set<string>;
  last_touch_ms: number;
}

const SESSION_MEMO = new Map<string, SessionRuleMemo>();

/** 30-minute idle TTL (in milliseconds). */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

function evictIdleSessions(nowMs: number): void {
  for (const [sid, memo] of SESSION_MEMO) {
    if (nowMs - memo.last_touch_ms > SESSION_IDLE_TTL_MS) {
      SESSION_MEMO.delete(sid);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter the candidate rule list according to each rule's injection_strategy
 * and the feature flag. Returns the rules that should appear in the hook
 * payload plus a breakdown of how many candidates hit each strategy bucket.
 */
export function selectInjectedRules(input: SelectInjectedRulesInput): SelectInjectedRulesOutput {
  const nowMs = Date.now();
  evictIdleSessions(nowMs);

  const breakdown: SelectInjectedRulesOutput["breakdown"] = {
    per_call: 0,
    session_once: 0,
    session_once_skipped: 0,
    claude_md_only_skipped: 0,
  };
  const injected: CandidateRule[] = [];

  // ── Feature flag off — every rule behaves as per_call ────────────────────
  if (!input.promotion_enabled) {
    for (const rule of input.candidates) {
      injected.push(rule);
      breakdown.per_call++;
    }
    return { injected, breakdown };
  }

  // ── Feature flag on — apply per-rule strategy ────────────────────────────
  let memo = SESSION_MEMO.get(input.session_id);
  if (!memo) {
    memo = { rules: new Set<string>(), last_touch_ms: nowMs };
    SESSION_MEMO.set(input.session_id, memo);
  }
  memo.last_touch_ms = nowMs;

  for (const rule of input.candidates) {
    switch (rule.injection_strategy) {
      case "per_call":
        injected.push(rule);
        breakdown.per_call++;
        break;

      case "session_once":
        if (memo.rules.has(rule.rule_id)) {
          breakdown.session_once_skipped++;
        } else {
          memo.rules.add(rule.rule_id);
          injected.push(rule);
          breakdown.session_once++;
        }
        break;

      case "claude_md_only":
        // Never in the hook payload when flag is on.
        breakdown.claude_md_only_skipped++;
        break;
    }
  }

  return { injected, breakdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test utilities — NOT exported via the package index
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reset the in-process session memo. For use in tests only.
 * Do NOT call this from production code.
 */
export function __resetSessionRuleMemoForTests(): void {
  SESSION_MEMO.clear();
}

/**
 * Inspect memo size — for assertion in tests only.
 */
export function __getSessionMemoSizeForTests(): number {
  return SESSION_MEMO.size;
}

/**
 * Advance the last_touch_ms of every session by `deltaMs` — for TTL eviction
 * tests. Do NOT call from production code.
 */
export function __advanceSessionTimestampsForTests(deltaMs: number): void {
  for (const memo of SESSION_MEMO.values()) {
    memo.last_touch_ms -= deltaMs;
  }
}
