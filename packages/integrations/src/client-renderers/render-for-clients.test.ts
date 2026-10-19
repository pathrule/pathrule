// SPDX-License-Identifier: Apache-2.0
// RenderForClients routes slim clients (Claude) to the router projection
// while every other client keeps the full bodies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompiledKnowledgeNode } from "@pathrule/core";
import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

import { renderForClients } from "./orchestrator.js";
import type { MultiClientInput } from "./types.js";

const FULL: CompiledKnowledgeNode[] = [
  {
    dir_path: "/lib",
    markdown:
      "> Authoritative...\n\n## Knowledge & decisions\n\n### Encapsulation model\nPlugins create a new context.\n",
    memory_ids: ["m-lib"],
    rule_ids: [],
    skill_ids: [],
    truncated: false,
  },
];

const SLIM: CompiledKnowledgeNode[] = [
  {
    dir_path: "/lib",
    markdown:
      "> Authoritative...\n\n## Knowledge index (bodies delivered per prompt by Pathrule)\n\n- Encapsulation model\n",
    memory_ids: [],
    rule_ids: [],
    skill_ids: [],
    indexed_memory_ids: ["m-lib"],
    indexed_skill_ids: [],
    truncated: false,
  },
];

function input(): MultiClientInput {
  return {
    workspaceName: "demo",
    overview: [{ node_id: "n1", relative_path: "/lib", memories: [], rules: [], skills: [] }],
    knowledge: FULL,
    knowledgeSlim: SLIM,
  };
}

const fileText = (results: ReturnType<typeof renderForClients>, client: string) =>
  (results.find((r) => r.client === client)?.files ?? []).map((f) => f.body).join("\n");

describe("renderForClients slim swap", () => {
  it("claude-code renders the SLIM router (title index, no body)", () => {
    const out = renderForClients(input(), ["claude-code"]);
    const claude = fileText(out, "claude-code");
    expect(claude).toContain("Encapsulation model"); // title indexed
    expect(claude).not.toContain("Plugins create a new context."); // body NOT in the file
  });

  it("codex keeps the FULL bodies (unchanged)", () => {
    const out = renderForClients(input(), ["codex"]);
    const codex = fileText(out, "codex");
    expect(codex).toContain("Plugins create a new context."); // full body present
  });

  it("falls back to full for slim clients when knowledgeSlim is absent", () => {
    const noSlim = { ...input(), knowledgeSlim: undefined };
    const out = renderForClients(noSlim, ["claude-code"]);
    expect(fileText(out, "claude-code")).toContain("Plugins create a new context.");
  });
});

// Signature mode is decided PER CLIENT and only by the caller, because only the
// caller knows whether that client's hook is installed. A client left out of the
// list must render byte-identically to before, or this becomes a silent
// protocol-removal for everyone.
describe("renderForClients protocol channel", () => {
  it("leaves every client unchanged when no client is listed", () => {
    const before = renderForClients(input(), ["codex", "cursor", "copilot", "windsurf"]);
    const after = renderForClients(input(), ["codex", "cursor", "copilot", "windsurf"], {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("swaps the protocol for a signature only in the listed client", () => {
    const results = renderForClients(input(), ["codex", "cursor"], { protocolOnHook: ["codex"] });
    const codex = fileText(results, "codex");
    const cursor = fileText(results, "cursor");

    // Codex's hook carries the protocol: nothing goes into the person's AGENTS.md, not even a signature.
    const codexFiles = results.find((r) => r.client === "codex")!;
    expect(codexFiles.files.map((f) => f.path)).not.toContain("AGENTS.md");
    expect(codexFiles.ownedPaths).toContain("AGENTS.md"); // so the sweep takes an earlier region back
    expect(codex).not.toContain("pathrule_get_context");
    // Cursor was not listed, so it still carries the protocol.
    expect(cursor).toContain("pathrule_get_context");
  });

  // Superseded 2026-09-01. This used to assert the opposite — protocol out,
  // knowledge stays — because signature mode was scoped to the protocol alone.
  // The decision it now encodes is the users': write nothing into their repo but
  // the signature. Knowledge leaves with the protocol and arrives through the
  // hook, selected per prompt instead of loaded whole.
  it("signature mode takes the knowledge out too, not just the protocol", () => {
    const results = renderForClients(input(), ["codex"], { protocolOnHook: ["codex"] });
    const codex = fileText(results, "codex");
    expect(codex).not.toContain("Pathrule is active in this workspace"); // no signature either
    expect(codex).not.toContain("pathrule_get_context"); // protocol gone
    expect(codex).not.toContain("Encapsulation model"); // knowledge gone
  });

  // The engines that made this a five-client problem: antigravity, grok, kimi and
  // opencode have no renderer of their own — they all read AGENTS.md through the
  // codex target. Fixing this in the shared helper rather than per renderer is
  // what makes the nested files stop for all of them at once.
  it("emits no per-directory knowledge file for ANY client in signature mode", () => {
    const clients = ["claude-code", "cursor", "codex", "windsurf", "copilot"] as const;
    const results = renderForClients(input(), [...clients], { protocolOnHook: [...clients] });
    for (const r of results) {
      for (const f of r.files) {
        expect(f.body, `${r.client} ${f.path} still carries knowledge`).not.toContain(
          "Plugins create a new context.",
        );
      }
      // …but ownership is intact, so the sweep can delete what is already there.
      expect(r.ownedPaths.length, `${r.client} lost its owned paths`).toBeGreaterThan(0);
    }
    // Specifically the nested AGENTS.md every non-Claude engine reads.
    const codex = results.find((r) => r.client === "codex")!;
    expect(codex.files.map((f) => f.path)).not.toContain("lib/AGENTS.md");
    expect(codex.ownedPaths).toContain("lib/AGENTS.md");
  });
});
