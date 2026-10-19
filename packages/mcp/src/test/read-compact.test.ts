// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { capPreview } from "../lib/preview-cap.js";
import {
  compactMemory,
  compactRule,
  compactSkill,
} from "../lib/read-compact.js";
import type { Memory, Rule, Skill } from "@pathrule/protocol/content-types.js";

describe("capPreview", () => {
  it("returns string unchanged when shorter than cap", () => {
    expect(capPreview("short", 120)).toBe("short");
  });

  it("truncates and appends ellipsis when over cap", () => {
    const input = "a".repeat(200);
    const out = capPreview(input, 120);
    expect(out.length).toBe(121);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("a".repeat(120))).toBe(true);
  });

  it("handles empty string", () => {
    expect(capPreview("", 120)).toBe("");
  });

  it("does not add ellipsis when exactly at cap", () => {
    const input = "a".repeat(120);
    expect(capPreview(input, 120)).toBe(input);
  });

  it("normalises whitespace — collapses runs of newlines/spaces into single space", () => {
    expect(capPreview("a\n\n\nb   c", 120)).toBe("a b c");
  });
});

const fullMemory: Memory & { nodeRelativePath?: string | null } = {
  id: "mem-1",
  workspaceId: "ws-1",
  nodeId: "node-1",
  title: "Example memory",
  content: "## Heading\n\nBody text.",
  source: "claude",
  versionId: "ver-1",
  versionNumber: 3,
  createdBy: "user-1",
  lastEditedBy: "user-2",
  lastEditedAt: "2026-04-20T10:00:00Z",
  createdAt: "2026-04-19T10:00:00Z",
  updatedAt: "2026-04-20T10:00:00Z",
  nodeRelativePath: "/packages/mcp-server",
};

describe("compactMemory", () => {
  it("flattens row to MCP-consumer shape", () => {
    expect(compactMemory(fullMemory)).toEqual({
      id: "mem-1",
      title: "Example memory",
      content: "## Heading\n\nBody text.",
      node_path: "/packages/mcp-server",
      source: "claude",
      version_id: "ver-1",
      updated_at: "2026-04-20T10:00:00Z",
    });
  });

  it("returns node_path: null when nodeRelativePath missing", () => {
    const { nodeRelativePath: _unused, ...rest } = fullMemory;
    expect(compactMemory(rest).node_path).toBeNull();
  });

  it("does not carry audit UUIDs or versionNumber", () => {
    const out = compactMemory(fullMemory) as unknown as Record<string, unknown>;
    expect(out.workspaceId).toBeUndefined();
    expect(out.nodeId).toBeUndefined();
    expect(out.createdBy).toBeUndefined();
    expect(out.lastEditedBy).toBeUndefined();
    expect(out.versionNumber).toBeUndefined();
    expect(out.createdAt).toBeUndefined();
    expect(out.lastEditedAt).toBeUndefined();
  });
});

const fullRule: Rule & { nodeRelativePath?: string | null } = {
  id: "rule-1",
  workspaceId: "ws-1",
  name: "No service role",
  content: "Use JWT only.",
  scopeType: "project",
  priority: "high",
  versionId: "ver-1",
  versionNumber: 1,
  createdBy: "user-1",
  lastEditedBy: null,
  lastEditedAt: "2026-04-20T10:00:00Z",
  createdAt: "2026-04-20T10:00:00Z",
  updatedAt: "2026-04-20T10:00:00Z",
  nodeRelativePath: "/",
};

describe("compactRule", () => {
  it("flattens to MCP shape with scope_type + priority", () => {
    expect(compactRule(fullRule)).toEqual({
      id: "rule-1",
      name: "No service role",
      content: "Use JWT only.",
      node_path: "/",
      scope_type: "project",
      priority: "high",
      version_id: "ver-1",
      updated_at: "2026-04-20T10:00:00Z",
    });
  });
});

const fullSkill: Skill & { nodeRelativePath?: string | null } = {
  id: "skill-1",
  workspaceId: "ws-1",
  name: "forward-progress-measurement",
  description: "Reusable measurement template",
  content: "---\nname: ...\n---\n# Skill body",
  source: "manual",
  githubUrl: null,
  version: "1.0",
  tags: ["measurement"],
  versionId: "ver-1",
  versionNumber: 1,
  createdBy: "user-1",
  lastEditedBy: null,
  lastEditedAt: "2026-04-20T10:00:00Z",
  createdAt: "2026-04-20T10:00:00Z",
  updatedAt: "2026-04-20T10:00:00Z",
  contentFetchedAt: null,
  nodeRelativePath: "/",
};

describe("compactSkill", () => {
  it("flattens to MCP shape with source preserved", () => {
    expect(compactSkill(fullSkill)).toEqual({
      id: "skill-1",
      name: "forward-progress-measurement",
      content: "---\nname: ...\n---\n# Skill body",
      node_path: "/",
      source: "manual",
      version_id: "ver-1",
      updated_at: "2026-04-20T10:00:00Z",
    });
  });

  it("keeps source=github_ref (behaviour fork signal)", () => {
    const gh = {
      ...fullSkill,
      source: "github_ref" as const,
      githubUrl: "https://example.com",
    };
    expect(compactSkill(gh).source).toBe("github_ref");
  });
});
