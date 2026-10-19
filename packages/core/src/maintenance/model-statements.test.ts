// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { groundQuote, parseStatements } from "./model-statements.js";

describe("a model's quote is kept only as the prompt has it", () => {
  it("grounds a quote whose whitespace the model normalised, never one it changed", () => {
    expect(groundQuote("a  b\n c is the rule now, ok", "a b c is the rule now")).toBe("a b c is the rule now");
    expect(groundQuote("a b c is the rule now", "a b c was the rule")).toBeNull();
    expect(groundQuote("short", "short")).toBeNull();
  });

  it("reads the model's JSON with text around it, and nothing from anything else", () => {
    expect(parseStatements('Sure:\n{"statements":[{"quote":"q","kind":"decision","lang":"TR"}]}\nDone.')).toEqual([
      { quote: "q", kind: "decision", lang: "tr", beyond: true },
    ]);
    expect(parseStatements("nonsense")).toEqual([]);
    expect(parseStatements('{"statements":"x"}')).toEqual([]);
  });
});
