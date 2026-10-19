// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { extractSkillInvocationMarkers, extractPatternImportMarkers } from "./skill-invocation.js";

describe("skill vs pattern token distinction (collision guarantee)", () => {
  it("parses a plain ::skill-name as a skill", () => {
    const skills = extractSkillInvocationMarkers("please run ::code-review now");
    expect(skills.map((s) => s.name)).toEqual(["code-review"]);
    expect(extractPatternImportMarkers("please run ::code-review now")).toEqual([]);
  });

  it("NEVER parses ::pathrule:package:<slug> as a skill", () => {
    const prompt = "add ::pathrule:package:expo-react-native to this workspace";
    // The whole reserved ::pathrule: namespace is skipped by the skill parser, so
    // it can never be read as the skill `pathrule` and never fire find-skills.
    expect(extractSkillInvocationMarkers(prompt)).toEqual([]);
    expect(extractPatternImportMarkers(prompt).map((m) => m.slug)).toEqual([
      "expo-react-native",
    ]);
  });

  it("separates a mix of skills and pattern imports in one prompt", () => {
    const prompt =
      "::code-review then ::pathrule:package:nextjs-app-router and ::frontend-design";
    expect(extractSkillInvocationMarkers(prompt).map((s) => s.name)).toEqual([
      "code-review",
      "frontend-design",
    ]);
    expect(extractPatternImportMarkers(prompt).map((m) => m.slug)).toEqual([
      "nextjs-app-router",
    ]);
  });

  it("captures the full token (not the truncated `pathrule`) and dedupes slugs", () => {
    const markers = extractPatternImportMarkers(
      "::pathrule:package:supabase-rls ::pathrule:package:supabase-rls",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.slug).toBe("supabase-rls");
    expect(markers[0]?.raw).toBe("::pathrule:package:supabase-rls");
  });

  it("ignores tokens inside code spans/fences for both parsers", () => {
    const prompt = "`::pathrule:package:x` and ```\n::code-review\n```";
    expect(extractSkillInvocationMarkers(prompt)).toEqual([]);
    expect(extractPatternImportMarkers(prompt)).toEqual([]);
  });
});
