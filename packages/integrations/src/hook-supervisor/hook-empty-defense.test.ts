// SPDX-License-Identifier: Apache-2.0
// Tests for empty hook payload suppression

import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldSuppressEmptyPayload,
  getCounter,
  __resetCountersForTests,
} from "./hook-empty-defense.js";

describe("shouldSuppressEmptyPayload", () => {
  beforeEach(() => {
    __resetCountersForTests();
  });

  it("suppresses empty payload (no rules, no memories, no skills, no generic reminder)", () => {
    const result = shouldSuppressEmptyPayload({
      injectedRulesCount: 0,
      injectedMemoriesCount: 0,
      injectedSkillsCount: 0,
      hasGenericReminder: false,
    });
    expect(result).toBe(true);
    expect(getCounter("hook_empty_skipped")).toBe(1);
    expect(getCounter("hook_empty_all_filtered")).toBe(1);
  });

  it("does NOT suppress when rules present", () => {
    const result = shouldSuppressEmptyPayload({
      injectedRulesCount: 1,
      injectedMemoriesCount: 0,
      injectedSkillsCount: 0,
      hasGenericReminder: false,
    });
    expect(result).toBe(false);
    expect(getCounter("hook_empty_skipped")).toBe(0);
  });

  it("does NOT suppress when memories present", () => {
    const result = shouldSuppressEmptyPayload({
      injectedRulesCount: 0,
      injectedMemoriesCount: 2,
      injectedSkillsCount: 0,
      hasGenericReminder: false,
    });
    expect(result).toBe(false);
  });

  it("does NOT suppress when skills present", () => {
    const result = shouldSuppressEmptyPayload({
      injectedRulesCount: 0,
      injectedMemoriesCount: 0,
      injectedSkillsCount: 1,
      hasGenericReminder: false,
    });
    expect(result).toBe(false);
  });

  it("does NOT suppress when hasGenericReminder is true", () => {
    const result = shouldSuppressEmptyPayload({
      injectedRulesCount: 0,
      injectedMemoriesCount: 0,
      injectedSkillsCount: 0,
      hasGenericReminder: true,
    });
    expect(result).toBe(false);
    expect(getCounter("hook_empty_skipped")).toBe(0);
  });

  it("increments hook_empty_no_workspace when causeHint is no_workspace", () => {
    shouldSuppressEmptyPayload({
      injectedRulesCount: 0,
      injectedMemoriesCount: 0,
      injectedSkillsCount: 0,
      hasGenericReminder: false,
      causeHint: "no_workspace",
    });
    expect(getCounter("hook_empty_no_workspace")).toBe(1);
    expect(getCounter("hook_empty_all_filtered")).toBe(0);
  });

  it("counter assertions: after 100 synthetic empty events, hook_empty_skipped === 100", () => {
    for (let i = 0; i < 100; i++) {
      shouldSuppressEmptyPayload({
        injectedRulesCount: 0,
        injectedMemoriesCount: 0,
        injectedSkillsCount: 0,
        hasGenericReminder: false,
      });
    }
    expect(getCounter("hook_empty_skipped")).toBe(100);
  });
});
