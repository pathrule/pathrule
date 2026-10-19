// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DELIVERY_POLICY } from "@pathrule/integrations/context-delivery-policy.js";
import { extractSkillInvocationMarkers } from "@pathrule/protocol/skill-invocation.js";
import { PATHRULE_PROTOCOL, SKILL_GATE, renderProtocolRulesFile } from "@pathrule/integrations/pathrule-protocol.js";
import { setHookCommand } from "@pathrule/integrations/hook-supervisor/hook-command.js";
import { getRenderer, type MultiClientInput } from "@pathrule/integrations/client-renderers/registry.js";

// Renderers go through buildHookConfig() which now requires the absolute
// hook command path to be configured. Match the runtime call site in
// packages/mcp/src/server.ts so renderers see the same path.
setHookCommand(pathJoin(homedir(), ".pathrule", "bin", "pathrule-hook.js"));

// `rootContext` used to sit here and is gone from MultiClientInput: renderers
// never read root memories/rules/skills, so gathering them cost a query per
// rerender for bytes nobody emitted (see the note in client-renderers/types.ts).
// This assertion only reads the Codex protocol body, so the minimum shape is
// enough — `promotedRules`, `knowledge` and `knowledgeSlim` are all optional.
const rendererInput: MultiClientInput = {
  workspaceName: "pathrule",
  overview: [],
};

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("release confidence contract", () => {
  it("parses ::skill markers without false positives from code or inline prose", () => {
    const markers = extractSkillInvocationMarkers(
      "Use ::Electron-Frontend_Design here, not abc::bad or `::ignored`. Again ::electron-frontend_design.",
    );

    expect(markers.map((marker) => marker.name)).toEqual(["electron-frontend_design"]);
    expect(markers[0]?.raw).toBe("Electron-Frontend_Design");
  });

  it("keeps Codex companion guidance cloud-first for skill writes", () => {
    const codex = getRenderer("codex");
    expect(codex).not.toBeNull();

    const agents =
      codex?.render(rendererInput).find((file) => file.path === "AGENTS.md")?.body ?? "";

    expect(agents).toContain("pathrule_write_skill");
    expect(agents).toContain("::skill-name` is a hard gate");
    expect(agents).toContain("Do not edit materialized local Pathrule files");
    expect(agents).toContain(".codex/skills/**/SKILL.md");
    expect(agents).toContain("cloud state is authoritative");
    expect(bytes(agents)).toBeLessThan(2500);
  });

  it("keeps context delivery slim by default and reserves MCP for on-demand depth", () => {
    expect(DEFAULT_CONTEXT_DELIVERY_POLICY.companionPayloadMode).toBe("slim");
    expect(DEFAULT_CONTEXT_DELIVERY_POLICY.rules).toContainEqual(
      expect.objectContaining({ surface: "pre_tool", importance: "path_scoped" }),
    );
    expect(DEFAULT_CONTEXT_DELIVERY_POLICY.rules).toContainEqual(
      expect.objectContaining({ surface: "prompt", importance: "intent_scoped" }),
    );
    expect(DEFAULT_CONTEXT_DELIVERY_POLICY.rules).toContainEqual(
      expect.objectContaining({ surface: "mcp", importance: "on_demand" }),
    );

    // V36 minimal contract: only what the agent must be TOLD (and cannot learn from the runtime) stays.
    // The route-block instruction (hook injects it verbatim), strict-rule obedience (deny gate enforces
    // it), the full pattern-import steps and skill-hint wording (hook delivers on demand), and the
    // get_context router-depth / response-field detail were removed to cut the once-per-session token
    // cost. These assertions pin the surviving contract.
    const before = PATHRULE_PROTOCOL.before.join("\n");
    // 1. trust + no-re-explore lever (the discovery-saving behavior)
    expect(before).toContain("Pathrule is this workspace's knowledge layer");
    expect(before).toContain("injected by the Pathrule hook");
    expect(before).toContain("that body IS the content: use it directly");
    expect(before).toContain("do NOT grep, search, or re-read files to re-verify");
    // 2. staleness safety valve (code wins on contradiction)
    expect(before).toContain("the code wins for what exists today");
    expect(before).toContain("binds new work even when the code has not caught up");
    expect(before).toContain("Never silently resolve a code-vs-knowledge conflict");
    // 3. when to reach for MCP (don't over-call; do-call for discovery, incl. Turkish)
    expect(before).toContain("Do NOT reflexively call pathrule_get_context");
    expect(before).toContain("before any grep/read/fallback");
    expect(before).toContain("call pathrule_read_memory(id)");
    expect(before).toContain("listele, göster, bul, nerede, hangi, neler");
    // 4. the skill/pattern gate is not always-on: it rides only an index whose workspace holds skills
    expect(before).not.toContain("::skill-name");
    expect(SKILL_GATE).toContain("::skill-name` is a hard gate");
    expect(SKILL_GATE).toContain("PATTERN import, not a skill");
    expect(renderProtocolRulesFile({ skills: false })).not.toContain("::skill-name");
    expect(renderProtocolRulesFile()).toContain("::skill-name");
    // The always-on protocol is a small contract, not a manual: the whole rendered file under 2,200 chars.
    expect(before.length).toBeLessThan(2000);
    expect(renderProtocolRulesFile({ skills: false }).length).toBeLessThan(2200);
  });

});
