// SPDX-License-Identifier: Apache-2.0
// What Pathrule may do to files it does not own: nothing it cannot prove is its own.
//
// - A config it cannot read is never rewritten (it used to fold the whole file into `_backup`, which
//   switched the person's permissions off), and an older `_backup` goes back on uninstall.
// - A file of the person's that merely QUOTES a Pathrule banner is theirs: never replaced, never swept.
// - With Claude Code's rules folder switched off, nothing is written for it and the keep-current ask
//   rides the session-start protocol instead.
// - A folder a Cloud workspace no longer serves keeps nothing an agent could read of that workspace.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mergeRegionInto, regionBounds, retractRegion } from "@pathrule/core/paths/region.js";
import { recordManagedFileOwnership } from "@pathrule/core/storage/managed-file-ownership.js";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";
import {
  HookConfigUnreadableError,
  ensureClaudeSettingsHook,
  ensureCodexHooks,
  ensureCursorHooks,
} from "../pathrule-protocol.js";
import { applyEject, planEject } from "../eject.js";
import { claudeKnowledgeRenderer } from "./claude-knowledge-renderer.js";
import { clearRenderedKnowledge } from "./clear-knowledge.js";
import { writeMultiClientFiles } from "./disk-writer.js";
import { KNOWLEDGE_BANNER } from "./knowledge-files.js";
import { renderForClients } from "./orchestrator.js";
import { resolveWorkspaceProtocolChannel } from "./protocol-channel-fs.js";

beforeAll(() => setHookCommand("/home/pat/.pathrule/bin/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pathrule-footprint-"));
  tmps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
/** Every file under root, workspace-relative, with its text. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return out;
}

const JSONC = '{\n  // team permissions\n  "permissions": {"allow": ["Bash(ls:*)"]},\n}\n';

describe("hook configs Pathrule cannot read", () => {
  it("are refused, never folded into a string key", () => {
    for (const merge of [ensureClaudeSettingsHook, ensureCodexHooks, ensureCursorHooks]) {
      expect(() => merge(JSONC)).toThrow(HookConfigUnreadableError);
      expect(() => merge(JSONC, { uninstall: true })).toThrow(HookConfigUnreadableError);
      expect(() => merge("[1, 2]")).toThrow(HookConfigUnreadableError);
    }
  });

  it("an older Pathrule's `_backup` goes back exactly as it was on uninstall", () => {
    const installed = JSON.stringify({ _backup: JSONC, hooks: ensureClaudeSettingsHookHooks() }, null, 2);
    expect(ensureClaudeSettingsHook(installed, { uninstall: true })).toEqual({ body: JSONC, changed: true });
  });

  it("an older `_backup` the person added keys beside stays where it is", () => {
    const installed = JSON.stringify({ _backup: JSONC, model: "opus", hooks: ensureClaudeSettingsHookHooks() });
    const after = JSON.parse(ensureClaudeSettingsHook(installed, { uninstall: true }).body);
    expect(after).toEqual({ _backup: JSONC, model: "opus" });
  });
});

function ensureClaudeSettingsHookHooks(): unknown {
  return (JSON.parse(ensureClaudeSettingsHook(null).body) as { hooks: unknown }).hooks;
}

describe("a person's file that quotes a Pathrule banner", () => {
  const quoting = "# Team notes\n\nThe old sync wrote `<!-- Pathrule managed -->` at the top; ignore it.\n";

  it("keeps every byte when Pathrule adds its region", () => {
    const merged = mergeRegionInto(quoting, "region body");
    expect(merged.startsWith(quoting.trimEnd())).toBe(true);
    expect(merged).toContain("region body");
  });

  it("is never swept away from an owned path", async () => {
    const root = repo({ "apps/api/AGENTS.md": quoting, "CLAUDE.md": quoting });
    await writeMultiClientFiles({
      workspaceRoot: root,
      results: [{ client: "codex", files: [], ownedPaths: ["apps/api/AGENTS.md", "CLAUDE.md"] }],
      sweepFor: ["codex"],
    });
    expect(read(root, "apps/api/AGENTS.md")).toBe(quoting);
    expect(read(root, "CLAUDE.md")).toBe(quoting);
  });
});

describe("Claude Code's rules folder switched off (PATHRULE_RULES_FILES=off)", () => {
  const input = {
    workspaceName: "w",
    overview: [],
    companionMode: "signature" as const,
    knowledgeBinding: [{ dir_path: "/", markdown: "### Rule\nDo it.\n", memory_ids: [], rule_ids: ["r"], skill_ids: [], truncated: false }],
  };

  it("writes nothing for Claude Code, and still claims the folder so the sweep empties it", () => {
    expect(claudeKnowledgeRenderer.render({ ...input, rulesFiles: false })).toEqual([]);
    expect(claudeKnowledgeRenderer.ownedPaths({ ...input, rulesFiles: false })).toContain(".claude/rules/pathrule/workspace.md");
    expect(claudeKnowledgeRenderer.render(input).map((f) => f.path)).toContain(".claude/rules/pathrule/workspace.md");
  });

  it("moves the keep-current ask to the session-start protocol", async () => {
    const root = repo({ ".claude/settings.local.json": ensureClaudeSettingsHook(null).body });
    const home = repo({});
    const on = await resolveWorkspaceProtocolChannel({ workspaceRoot: root, enabled: ["claude-code"], env: { PATHRULE_HOME: home }, home });
    const off = await resolveWorkspaceProtocolChannel({ workspaceRoot: root, enabled: ["claude-code"], env: { PATHRULE_HOME: home, PATHRULE_RULES_FILES: "off" }, home, now: Date.now() + 10 * 60_000 });
    expect(on.signatureClients).toEqual(["claude-code"]);
    expect(on.protocol).not.toContain("Keep this knowledge current");
    expect(off.protocol).toContain("Keep this knowledge current");
  });
});

describe("a folder a Pathrule Cloud workspace no longer serves", () => {
  const CLOUD = "CLOUD-ONLY-DECISION-7f3a";
  const userAgents = "# Team notes\n\nRun make lint.\n";
  const userClaude = "# Project\n\nUse tabs.\n";
  const region = (body: string) =>
    `<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\n${body}\n<!-- pathrule:end -->\n`;

  it("keeps nothing of the workspace an agent could read, and every byte of the person's", async () => {
    const root = repo({
      // The person's files, one carrying a Cloud protocol region with the workspace's sections.
      "AGENTS.md": `${userAgents}\n${region(`<!-- Pathrule managed — do not edit; cloud state is authoritative. -->\n# Pathrule integration\n\n## Workspace knowledge (Pathrule)\n\n### Decision\n${CLOUD}`)}`,
      "CLAUDE.md": userClaude,
      // Claude Code's rules folder from a Cloud render.
      ".claude/rules/pathrule/workspace.md": `${KNOWLEDGE_BANNER}\n# Project instructions (Pathrule)\n\n${CLOUD}\n`,
      ".claude/rules/pathrule/apps-api.md": `---\npaths:\n  - "apps/api/**"\n---\n${KNOWLEDGE_BANNER}\n${CLOUD}\n`,
      ".claude/rules/pathrule/manifest.json": '{"_": "# >>> Pathrule managed: binding manifest"}\n',
      ".claude/rules/pathrule/.gitignore": "# Pathrule managed — compiled instructions, regenerated on sync.\n*\n",
      // A slim render's nested knowledge: a region in the person's file, and a file all Pathrule's.
      "apps/api/AGENTS.md": `${userAgents}\n${region(`${KNOWLEDGE_BANNER}\n${CLOUD}`)}`,
      "apps/web/AGENTS.md": region(`${KNOWLEDGE_BANNER}\n${CLOUD}`),
      ".cursor/rules/pathrule-k-apps.mdc": `---\nglobs: "apps/**"\n---\n${KNOWLEDGE_BANNER}\n${CLOUD}\n`,
      "src/index.ts": "export {};\n",
    });
    // The ledger knows only some of them: the walk finds the rest.
    await recordManagedFileOwnership({ workspaceRoot: root, paths: [".cursor/rules/pathrule-k-apps.mdc"], owner: "cli", ownerVersion: "1.0.1" });

    const first = await clearRenderedKnowledge(root);
    expect(first.errors).toEqual([]);

    const after = tree(root);
    for (const [rel, body] of Object.entries(after)) expect(body, rel).not.toContain(CLOUD);
    expect(after["CLAUDE.md"]).toBe(userClaude);
    expect(after["apps/api/AGENTS.md"]).toBe(userAgents);
    expect(after["AGENTS.md"]).toBe(userAgents);
    expect(after["src/index.ts"]).toBe("export {};\n");
    expect(Object.keys(after).filter((p) => p.startsWith(".claude/") || p.startsWith(".cursor/") || p === "apps/web/AGENTS.md")).toEqual([]);

    // A second run changes nothing.
    const second = await clearRenderedKnowledge(root);
    expect(second).toEqual({ removed: 0, stripped: 0, unclear: [], errors: [] });
    expect(tree(root)).toEqual(after);
  });
});

describe("what an older Pathrule left, on upgrade and on eject", () => {
  const BEGIN = "<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->";
  const END = "<!-- pathrule:end -->";
  const signature =
    "<!-- Pathrule managed — do not edit; cloud state is authoritative. -->\n\nPathrule is active in this workspace.";
  const mine = ["# Project\n\nUse tabs.\n", "# Project\n\n\n  indented\n\n", "no trailing newline", "\n\nstarts blank\n"];

  it("splicing a region in and retracting it gives the person's file back", () => {
    for (const body of mine) {
      const merged = mergeRegionInto(body, "x");
      const bounds = regionBounds(merged);
      expect(bounds.kind).toBe("one");
      const back = retractRegion(merged, bounds as { begin: number; end: number });
      expect(back, JSON.stringify(body)).toBe(body.endsWith("\n") ? body.replace(/\n+$/, "\n") : `${body}\n`);
    }
  });

  it("a sync takes the root CLAUDE.md signature of an older version back out, byte for byte", async () => {
    const userClaude = "# Project\n\nUse tabs.\n";
    const root = repo({ "CLAUDE.md": `${userClaude}\n${BEGIN}\n${signature}\n${END}\n` });
    const results = renderForClients({ workspaceName: "w", overview: [] }, ["claude-code"], { protocolOnHook: ["claude-code"] });
    const res = await writeMultiClientFiles({ workspaceRoot: root, results, sweepFor: ["claude-code"] });
    expect(res.errors).toEqual([]);
    expect(read(root, "CLAUDE.md")).toBe(userClaude);
    // Again: nothing to do.
    const again = await writeMultiClientFiles({ workspaceRoot: root, results, sweepFor: ["claude-code"] });
    expect(again.changed.filter((p) => p === "CLAUDE.md")).toEqual([]);
  });

  it("a region whose end anchor was lost is left byte for byte by the sweep, the writer and eject, and reported", async () => {
    const lost = `# Mine\n\nRun make lint.\n\n${BEGIN}\n${signature}\nand whatever the person wrote after it\n`;
    const twice = `# Mine\n\n${BEGIN}\nx\n${END}\n\n${BEGIN}\ny\n${END}\n`;
    const root = repo({ "AGENTS.md": lost, "CLAUDE.md": twice });

    const swept = await writeMultiClientFiles({
      workspaceRoot: root,
      results: [{ client: "codex", files: [], ownedPaths: ["AGENTS.md", "CLAUDE.md"] }],
      sweepFor: ["codex"],
    });
    expect(read(root, "AGENTS.md")).toBe(lost);
    expect(read(root, "CLAUDE.md")).toBe(twice);
    expect(swept.errors.map((e) => e.path).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);

    const written = await writeMultiClientFiles({
      workspaceRoot: root,
      results: [{ client: "codex", files: [{ path: "AGENTS.md", body: "protocol" }], ownedPaths: ["AGENTS.md"] }],
      sweepFor: ["codex"],
    });
    expect(read(root, "AGENTS.md")).toBe(lost);
    expect(written.errors.map((e) => e.path)).toEqual(["AGENTS.md"]);

    const plan = await planEject(root);
    expect(plan.actions.filter((a) => a.path === "AGENTS.md" || a.path === "CLAUDE.md")).toEqual([]);
    expect(plan.unclear.map((u) => u.path).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
    await applyEject(root, plan);
    expect(read(root, "AGENTS.md")).toBe(lost);
    expect(read(root, "CLAUDE.md")).toBe(twice);
  });

  it("eject takes an older version's region and whole files out and gives the person's bytes back", async () => {
    const userAgents = "# Agent notes\n\nThis repo uses pnpm.\n";
    const root = repo({
      "AGENTS.md": `${userAgents}\n${BEGIN}\n${signature}\n${END}\n`,
      "packages/api/AGENTS.md": `${BEGIN}\n${KNOWLEDGE_BANNER}\nknowledge\n${END}\n`,
      "packages/web/CLAUDE.md": "<!-- managed by Pathrule — do not edit this file manually. -->\n# Pathrule Workspace\n",
      "notes/CLAUDE.md": "# Notes\n\nThe old sync wrote `<!-- managed by Pathrule -->` here.\n",
    });
    const result = await applyEject(root, await planEject(root));
    expect(result.failed).toBe(0);
    const after = tree(root);
    expect(after).toEqual({
      "AGENTS.md": userAgents,
      "notes/CLAUDE.md": "# Notes\n\nThe old sync wrote `<!-- managed by Pathrule -->` here.\n",
    });
    expect((await planEject(root)).actions).toEqual([]);
  });
});
