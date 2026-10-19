// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { classifyDeterministicRoute } from "../lib/deterministic-routing.js";

describe("deterministic routing", () => {
  it("keeps direct command prompts off the LLM router", () => {
    const route = classifyDeterministicRoute({
      userIntent: "pnpm typecheck çalıştır",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("execute_only");
    expect(route.skip_llm_router).toBe(true);
    expect(route.context_depth).toBe("minimal");
  });

  it("does not mistake broad release QA requests for direct test commands", () => {
    const route = classifyDeterministicRoute({
      userIntent:
        "Mevcut Pathrule'un tüm özelliklerini test et: hook, mcp, context büyüklüğü, token testi, ai router ve skorlama testleri",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("architecture_discovery");
    expect(route.skip_llm_router).toBe(true);
    expect(route.context_depth).toBe("deep");
    expect(route.include).toEqual(["workspace_overview", "recent_activities"]);
  });

  it("routes Pathrule debug/performance prompts without the LLM router", () => {
    const route = classifyDeterministicRoute({
      userIntent: "Router timeout telemetry analiz",
      relativePath: "/packages/mcp-server",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("known_area_bug");
    expect(route.task_shape).toBe("debug");
    expect(route.context_depth).toBe("focused");
    expect(route.skip_llm_router).toBe(true);
  });

  it("routes explicit ++history prompts to prior work without LLM routing", () => {
    const route = classifyDeterministicRoute({
      userIntent: "++history context router skill invocation nasıl çalışıyordu?",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("history_question");
    expect(route.context_depth).toBe("focused");
    expect(route.include).toEqual(["prior_work"]);
    expect(route.skip_llm_router).toBe(true);
  });

  it("treats context quality/noise prompts as deep MCP discovery", () => {
    const route = classifyDeterministicRoute({
      userIntent:
        "Bir prompt verince gürültü var mı, doğru yeterli bağlamı sağlıyor mu ve hook çözemezse MCP get_context verimli dönüyor mu?",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("architecture_discovery");
    expect(route.context_depth).toBe("deep");
    expect(route.include).toEqual(["workspace_overview", "recent_activities"]);
    expect(route.skip_llm_router).toBe(true);
  });

  it("routes explicit UI/product prompts without the LLM router", () => {
    const route = classifyDeterministicRoute({
      userIntent: "modal'ları i18n standardına çek",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("known_area_ui");
    expect(route.task_shape).toBe("new_feature");
    expect(route.context_depth).toBe("focused");
    expect(route.skip_llm_router).toBe(true);
  });

  it("routes mobile screen prompts as UI without Pathrule-specific keywords", () => {
    const route = classifyDeterministicRoute({
      userIntent: "mobile onboarding ekranını düzenle",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("known_area_ui");
    expect(route.skip_llm_router).toBe(true);
  });

  it("keeps genuinely ambiguous prompts eligible for the LLM router", () => {
    const route = classifyDeterministicRoute({
      userIntent: "şunu toparla",
      relativePath: "/",
      recentActivities: [],
      workspaceOverview: [],
    });

    expect(route.intent_class).toBe("unknown");
    expect(route.skip_llm_router).toBe(false);
  });
});
