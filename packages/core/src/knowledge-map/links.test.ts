// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createLinkResolver, extractLinkTargets, slugify, type LinkTargetItem } from "./links.js";

const items: LinkTargetItem[] = [
  { id: "m-voice", kind: "memory", title: "Pathrule voice and copy style guide" },
  { id: "r-takeover", kind: "rule", title: "Never take over a user's agent instruction file" },
  { id: "m-frame", kind: "memory", title: "Animate with AI must read frame.html" },
  { id: "m-stall", kind: "memory", title: "Turn-stall watchdog: no timeout on a blocked claude-code turn" },
  {
    id: "m-editor",
    kind: "memory",
    title: "Design editor: stable element identity + direct-manipulation editing model",
  },
  { id: "s-ios", kind: "skill", title: "ios-ui-craft" },
  { id: "s-selfhost", kind: "skill", title: "Operate the self-hosted stack" },
  { id: "m-ios", kind: "memory", title: "ios ui craft notes" },
  { id: "m-release-a", kind: "memory", title: "Release train desktop notarization" },
  { id: "m-release-b", kind: "memory", title: "Release train desktop signing" },
];

describe("extractLinkTargets", () => {
  it("strips alias and heading and keeps first spelling, deduped case-insensitively", () => {
    expect(extractLinkTargets("See [[alpha-beta|Alpha]], [[Gamma#h]] and [[gamma]]")).toEqual([
      "alpha-beta",
      "Gamma",
    ]);
  });

  it("ignores links inside fenced and inline code", () => {
    const body = ["keep [[kept]]", "```", "[[fenced]] ::fenced-skill", "```", "`[[inline]]` done"].join("\n");
    expect(extractLinkTargets(body)).toEqual(["kept"]);
  });

  it("reads ::skill refs, including the usual backticked form", () => {
    expect(extractLinkTargets("use ::ios-ui-craft here, then `::renderer-idle-cost-audit`.")).toEqual([
      "::ios-ui-craft",
      "::renderer-idle-cost-audit",
    ]);
  });

  it("does not read scope operators, IPv6, pattern imports or empty links", () => {
    expect(extractLinkTargets("std::vector and fe80::1 and Vec::new")).toEqual([]);
    expect(extractLinkTargets("import ::pathrule:package:supabase-rls first")).toEqual([]);
    expect(extractLinkTargets("[[...]] and [[ ]]")).toEqual([]);
    expect(extractLinkTargets(undefined)).toEqual([]);
    expect(extractLinkTargets(null)).toEqual([]);
  });
});

describe("createLinkResolver", () => {
  const resolver = createLinkResolver(items);

  it("exact: title, kebab title or explicit slug", () => {
    expect(resolver.resolve("Pathrule voice and copy style guide")).toEqual({ id: "m-voice", stage: "exact" });
    expect(resolver.resolve("pathrule-voice-and-copy-style-guide")).toEqual({ id: "m-voice", stage: "exact" });
    const withSlug = createLinkResolver([{ id: "x", kind: "memory", title: "Some title", slug: "custom-slug" }]);
    expect(withSlug.resolve("custom-slug")).toEqual({ id: "x", stage: "exact" });
  });

  it("apostrophe: users matches user's (straight or curly)", () => {
    expect(resolver.resolve("never-take-over-a-users-agent-instruction-file")).toEqual({
      id: "r-takeover",
      stage: "apostrophe",
    });
    const curly = createLinkResolver([{ id: "c", kind: "rule", title: "Respect the owner’s choice" }]);
    expect(curly.resolve("respect-the-owners-choice")).toEqual({ id: "c", stage: "apostrophe" });
  });

  it("punctuation: frame.html matches framehtml", () => {
    expect(resolver.resolve("animate-with-ai-must-read-framehtml")).toEqual({ id: "m-frame", stage: "punctuation" });
  });

  it("prefix: a shortened slug resolves to the one title that starts with it", () => {
    expect(resolver.resolve("turn-stall-watchdog")).toEqual({ id: "m-stall", stage: "prefix" });
  });

  it("subset: every word of the link appears in exactly one title", () => {
    expect(resolver.resolve("design-editor-stable-identity-direct-manipulation")).toEqual({
      id: "m-editor",
      stage: "subset",
    });
  });

  it("returns null when a prefix or subset matches more than one title", () => {
    expect(resolver.resolve("release-train-desktop")).toBeNull();
  });

  it("returns null for short links that would only match loosely", () => {
    expect(resolver.resolve("turn-stall")).toBeNull();
    expect(resolver.resolve("does-not-exist-anywhere")).toBeNull();
    expect(resolver.resolve("!!!")).toBeNull();
  });

  it("::name resolves only skills, by name or by the kebab form of the name", () => {
    expect(resolver.resolve("::ios-ui-craft")).toEqual({ id: "s-ios", stage: "exact" });
    expect(resolver.resolve("::operate-the-self-hosted-stack")).toEqual({ id: "s-selfhost", stage: "exact" });
    expect(resolver.resolve("::pathrule-voice-and-copy-style-guide")).toBeNull();
  });

  it("is independent of input order when two items share a title", () => {
    const a: LinkTargetItem = { id: "a", kind: "memory", title: "Shared" };
    const b: LinkTargetItem = { id: "b", kind: "memory", title: "Shared" };
    expect(createLinkResolver([a, b]).resolve("shared")).toEqual(createLinkResolver([b, a]).resolve("shared"));
  });
});

describe("slugify", () => {
  it("kebab-cases and trims separators", () => {
    expect(slugify("  Turn-stall watchdog: no timeout!  ")).toBe("turn-stall-watchdog-no-timeout");
  });
});
