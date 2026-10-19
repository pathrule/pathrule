// SPDX-License-Identifier: Apache-2.0
// Signature mode: Pathrule stops writing into the user's tree (2026-09-01).
//
// The complaint this answers was never token cost. It was that Pathrule authored
// 26 files across 13 directories of a repo the team owns, and users said so. The
// decision: write nothing but a signature in the root CLAUDE.md / AGENTS.md.
//
// Turning the flag on was not enough. `claude-knowledge-renderer` never read
// `companionMode`, so signature ON and OFF produced byte-identical output —
// measured before this test existed — and only `pathrule-protocol.md`, which has
// its own bespoke remover, actually went away. 25 files stayed.
//
// The two assertions below are the whole contract, and the second is the one that
// is easy to lose: emitting nothing STOPS the writes, but only a complete
// `ownedPaths` makes disk-writer REMOVE what earlier versions already wrote.
// Narrow them together and the files sit there forever, drifting.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CompiledKnowledgeNode } from "@pathrule/core";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";
beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

import { renderForClients } from "./orchestrator.js";
import { writeMultiClientFiles } from "./disk-writer.js";
import type { MultiClientInput } from "./types.js";

const KNOWLEDGE: CompiledKnowledgeNode[] = [
  { dir_path: "/", markdown: "> A\n\n### Root fact\nRoot body.\n", memory_ids: ["m0"], rule_ids: [], skill_ids: [], truncated: false },
  { dir_path: "/apps/api", markdown: "> A\n\n### API fact\nAPI body.\n", memory_ids: ["m1"], rule_ids: [], skill_ids: [], truncated: false },
  { dir_path: "/apps/mobile", markdown: "> A\n\n### Mobile fact\nMobile body.\n", memory_ids: ["m2"], rule_ids: [], skill_ids: [], truncated: false },
];

const input = (): MultiClientInput => ({
  workspaceName: "demo",
  overview: [
    { node_id: "n1", relative_path: "/apps/api", memories: [], rules: [], skills: [] },
    { node_id: "n2", relative_path: "/apps/mobile", memories: [], rules: [], skills: [] },
  ],
  knowledge: KNOWLEDGE,
});

const render = (signature: boolean) =>
  renderForClients(input(), ["claude-code"], signature ? { protocolOnHook: ["claude-code"] } : undefined);

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "pathrule-signature-"));
  tmps.push(d);
  return d;
}

describe("signature mode footprint", () => {
  it("emits only its own self-ignoring rules folder, while normal mode still emits the knowledge files", () => {
    const normal = render(false).find((r) => r.client === "claude-code")!;
    const signed = render(true).find((r) => r.client === "claude-code")!;

    expect(normal.files.length).toBeGreaterThan(0);
    expect(normal.files.map((f) => f.path)).toContain(".claude/rules/pathrule-knowledge.md");
    expect(signed.files.length).toBeGreaterThan(0);
    for (const f of signed.files) expect(f.path.startsWith(".claude/rules/pathrule/")).toBe(true);
    expect(signed.files.map((f) => f.path)).toContain(".claude/rules/pathrule/.gitignore");
  });

  it("still claims every path it used to own, so the sweep can remove them", () => {
    const signed = render(true).find((r) => r.client === "claude-code")!;
    const normal = render(false).find((r) => r.client === "claude-code")!;
    // Emitting nothing must not shrink ownership: the sweep deletes exactly the
    // owned paths this run did not emit.
    expect(signed.ownedPaths).toEqual(normal.ownedPaths);
    expect(signed.ownedPaths).toContain(".claude/rules/pathrule-knowledge.md");
  });

  it("removes files an earlier non-signature sync already wrote", async () => {
    const root = freshRepo();
    // Simulate the repo as an earlier version left it.
    const before = render(false).find((r) => r.client === "claude-code")!;
    for (const f of before.files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.body);
    }
    for (const f of before.files) expect(existsSync(join(root, f.path))).toBe(true);

    const result = await writeMultiClientFiles({
      workspaceRoot: root,
      results: render(true),
      sweepFor: ["claude-code"],
      runtimeOwner: "cli",
      runtimeVersion: "0",
    });

    expect(result.errors).toEqual([]);
    // Everything the earlier render wrote is gone, but for what signature mode writes itself
    // (the rules folder's own ignore file is the same path in both).
    const signedPaths = new Set(render(true).flatMap((r) => r.files.map((f) => f.path)));
    for (const f of before.files.filter((x) => !signedPaths.has(x.path))) {
      expect(existsSync(join(root, f.path)), `${f.path} should be gone`).toBe(false);
    }
    expect(result.removed).toBeGreaterThan(0);
  });

  it("never deletes a user-authored file sitting at an owned path", async () => {
    const root = freshRepo();
    const userFile = join(root, "apps/api/CLAUDE.md");
    mkdirSync(dirname(userFile), { recursive: true });
    writeFileSync(userFile, "# Our own team instructions\n\nDo not touch this.\n");

    await writeMultiClientFiles({
      workspaceRoot: root,
      results: render(true),
      sweepFor: ["claude-code"],
      runtimeOwner: "cli",
      runtimeVersion: "0",
    });

    expect(existsSync(userFile)).toBe(true);
    expect(readFileSync(userFile, "utf8")).toContain("Do not touch this.");
  });
});
