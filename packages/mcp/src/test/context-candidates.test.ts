// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ContextBundle } from "@pathrule/core/tools/tree.js";
import { buildContextCandidateSet, summarizeCandidateSet } from "../lib/context-candidates.js";

function bundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    resolved_workspace_path: "/",
    node: { id: "root", name: "root", relative_path: "/" },
    memories: [],
    rules: [],
    skills: [],
    workspace_overview: [],
    ...overrides,
  };
}

describe("context candidate selector", () => {
  it("treats high priority as a bonus only when the rule is relevant", () => {
    const set = buildContextCandidateSet({
      userIntent: "modal i18n standardını yeniden ele al",
      relativePath: "/packages/app",
      recentActivities: [],
      bundle: bundle({
        resolved_workspace_path: "/packages/app",
        node: { id: "app", name: "app", relative_path: "/packages/app" },
        rules: [
          { id: "r1", name: "Modal i18n standard", scope_type: "path", priority: "high" },
          { id: "r2", name: "Release signing checklist", scope_type: "path", priority: "high" },
        ],
      }),
    });

    const relevant = set.candidates.find((candidate) => candidate.id === "r1");
    const unrelated = set.candidates.find((candidate) => candidate.id === "r2");

    expect(relevant?.reasons).toContain("relevant-high-priority");
    expect(unrelated?.reasons).not.toContain("relevant-high-priority");
    expect(relevant?.score ?? 0).toBeGreaterThan(unrelated?.score ?? 0);
  });

  it("keeps broad area refactors as area candidate sets instead of a tiny file guess", () => {
    const set = buildContextCandidateSet({
      userIntent: "supabase tarafı çok dağıldı yönetemiyoruz refactor et",
      relativePath: "/",
      recentActivities: [
        {
          domain: "backend",
          action: "update",
          task_summary: "Refactored Supabase Edge Functions and migrations",
          created_at: "2026-05-02T10:00:00Z",
          node_path: "/supabase/functions",
          files_touched: { total: 6 },
        },
      ],
      bundle: bundle({
        workspace_overview: [
          {
            node_id: "functions",
            relative_path: "/supabase/functions",
            memories: [{ id: "m1", title: "Supabase Edge Function access pattern" }],
            rules: [
              {
                id: "r1",
                name: "Supabase Edge Functions must validate workspace access",
                scope_type: "path",
                priority: "high",
              },
            ],
            skills: [{ id: "s1", name: "supabase-migration-workflow", source: "local" }],
          },
          {
            node_id: "migrations",
            relative_path: "/supabase/migrations",
            memories: [{ id: "m2", title: "Supabase migration order" }],
            rules: [],
            skills: [],
          },
          {
            node_id: "billing",
            relative_path: "/packages/app/billing",
            memories: [],
            rules: [{ id: "r2", name: "Stripe billing rules", scope_type: "path", priority: "high" }],
            skills: [],
          },
        ],
      }),
    });

    const summary = summarizeCandidateSet(set);
    const topPaths = new Set(summary.top.map((candidate) => candidate.node_path));

    expect(summary.broadness).toBe("area");
    expect(summary.task_hints).toContain("database");
    expect(topPaths.has("/supabase/functions")).toBe(true);
    expect(topPaths.has("/supabase/migrations")).toBe(true);
    expect(summary.top.length).toBeGreaterThan(3);
  });

  it("recognizes mobile screen prompts as UI hints", () => {
    const set = buildContextCandidateSet({
      userIntent: "mobile onboarding ekranını düzenle",
      relativePath: "/",
      recentActivities: [],
      bundle: bundle({
        workspace_overview: [
          {
            node_id: "mobile",
            relative_path: "/apps/mobile",
            memories: [{ id: "m1", title: "Mobile onboarding flow" }],
            rules: [],
            skills: [],
          },
        ],
      }),
    });

    const summary = summarizeCandidateSet(set);

    expect(summary.task_hints).toContain("ui");
    expect(summary.top.some((candidate) => candidate.node_path === "/apps/mobile")).toBe(true);
  });

  it("keeps context-quality prompts focused on Pathrule surfaces instead of unrelated high rules", () => {
    const set = buildContextCandidateSet({
      userIntent:
        "Bir prompt verince gürültü var mı, doğru yeterli bağlamı sağlıyor mu ve hook çözemezse MCP get_context verimli dönüyor mu?",
      relativePath: "/",
      recentActivities: [
        {
          domain: "mcp",
          action: "update",
          task_summary: "Reduced get_context response noise and added hook fallback telemetry",
          created_at: "2026-05-04T10:00:00Z",
          node_path: "/packages/mcp-server",
          files_touched: { total: 4 },
        },
      ],
      bundle: bundle({
        workspace_overview: [
          {
            node_id: "mcp",
            relative_path: "/packages/mcp-server",
            memories: [{ id: "m1", title: "MCP get_context response-shape and fallback policy" }],
            rules: [
              {
                id: "r1",
                name: "Context responses must stay sufficient without noisy unrelated rules",
                scope_type: "path",
                priority: "high",
              },
            ],
            skills: [{ id: "s1", name: "forward-progress-measurement", source: "local" }],
          },
          {
            node_id: "hook",
            relative_path: "/packages/shared/src/hook-supervisor",
            memories: [{ id: "m2", title: "Hook injection size budget and prompt matching" }],
            rules: [],
            skills: [],
          },
          {
            node_id: "supabase",
            relative_path: "/supabase",
            memories: [],
            rules: [
              {
                id: "r2",
                name: "User JWT only — never service role",
                scope_type: "path",
                priority: "high",
              },
            ],
            skills: [{ id: "s2", name: "supabase-migration-workflow", source: "local" }],
          },
        ],
      }),
    });

    const summary = summarizeCandidateSet(set);
    const topLabels = summary.top.map((candidate) => candidate.label);

    expect(summary.broadness).toBe("area");
    expect(summary.task_hints).toContain("debug");
    expect(summary.top.some((candidate) => candidate.node_path === "/packages/mcp-server")).toBe(
      true,
    );
    expect(
      summary.top.some(
        (candidate) => candidate.node_path === "/packages/shared/src/hook-supervisor",
      ),
    ).toBe(true);
    expect(topLabels).not.toContain("User JWT only — never service role");
  });
});
