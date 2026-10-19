// SPDX-License-Identifier: Apache-2.0
// Brownfield sync contract — what actually happens on disk when Pathrule syncs
// into a repo that ALREADY has agent instruction files.
//
// These are behaviour probes, not aspirations: each `it` asserts the CURRENT
// observed behaviour so a future change to safe-write / the renderers can never
// silently alter what happens to a user's pre-existing files. Where the current
// behaviour is a known defect, the test says so in its name and asserts the
// defect, so fixing it is a deliberate, visible test change.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledKnowledgeNode } from "@pathrule/core";

import { __resetHookCommandForTests, setHookCommand } from "../hook-supervisor/hook-command.js";

beforeAll(() => setHookCommand("/tmp/pathrule-hook.js"));
afterAll(() => __resetHookCommandForTests());

import { renderForClients } from "./orchestrator.js";
import { writeMultiClientFiles } from "./disk-writer.js";
import { stripRegion } from "@pathrule/core/paths/region.js";
import type { MultiClientInput } from "./types.js";

// ─── Fixture: a realistic brownfield repo ────────────────────────────────────

/** The user's root CLAUDE.md: deep imports, code fences, real conventions. */
const USER_ROOT_CLAUDE = `# Acme Platform

See @docs/architecture.md for the service map.

## Setup

\`\`\`bash
# Install dependencies first
pnpm install
\`\`\`

## Conventions
Use camelCase everywhere.
`;

/** The user's own nested instruction file for one package. */
const USER_NESTED_CLAUDE = `# API package

Node 20 only. Never import from packages/web here.
`;

/** The user's AGENTS.md — the Linux Foundation cross-runtime standard. */
const USER_AGENTS = `# Acme Platform (AGENTS.md)

Run \`pnpm test\` before every commit.
`;

const KNOWLEDGE: CompiledKnowledgeNode[] = [
  {
    dir_path: "/",
    markdown: "> Authoritative...\n\n## Rules (must follow)\n\n### Root rule\nDo the thing.\n",
    memory_ids: [],
    rule_ids: ["r-root"],
    skill_ids: [],
    truncated: false,
  },
  {
    dir_path: "/packages/api",
    markdown: "> Authoritative...\n\n## Rules (must follow)\n\n### API rule\nValidate input.\n",
    memory_ids: [],
    rule_ids: ["r-api"],
    skill_ids: [],
    truncated: false,
  },
];

function baseInput(overrides: Partial<MultiClientInput> = {}): MultiClientInput {
  return {
    workspaceName: "acme",
    overview: [
      { node_id: "n1", relative_path: "/packages/api", memories: [], rules: [], skills: [] },
    ],
    knowledge: KNOWLEDGE,
    knowledgeSlim: KNOWLEDGE,
    ...overrides,
  };
}

/** Build the brownfield repo on disk and return its root. */
async function makeBrownfieldRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pathrule-brownfield-"));
  await mkdir(join(root, "packages", "api"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "CLAUDE.md"), USER_ROOT_CLAUDE, "utf8");
  await writeFile(join(root, "packages", "api", "CLAUDE.md"), USER_NESTED_CLAUDE, "utf8");
  await writeFile(join(root, "AGENTS.md"), USER_AGENTS, "utf8");
  await writeFile(join(root, "docs", "architecture.md"), "# Architecture\n\nService map.\n", "utf8");
  return root;
}

async function sync(root: string, clients: Array<"claude-code" | "codex">, input = baseInput()) {
  const results = renderForClients(input, clients);
  return writeMultiClientFiles({
    workspaceRoot: root,
    results,
    sweepFor: clients,
    runtimeOwner: "desktop",
    runtimeVersion: "1.0.0",
  });
}

const read = async (root: string, rel: string): Promise<string | null> => {
  try {
    return await readFile(join(root, rel), "utf8");
  } catch {
    return null;
  }
};

// ─── Probes ──────────────────────────────────────────────────────────────────

describe("brownfield sync: user's nested CLAUDE.md", () => {
  it("leaves the person's nested CLAUDE.md byte-identical and puts the area's knowledge in Pathrule's own file", async () => {
    const root = await makeBrownfieldRepo();
    const res = await sync(root, ["claude-code"]);

    // Nothing is moved aside, and the person's file is not touched at all.
    expect(res.backedUp).toEqual([]);
    expect(await read(root, ".pathrule/backups/packages/api/CLAUDE.md")).toBeNull();
    expect(await read(root, "packages/api/backup.CLAUDE.md")).toBeNull();
    expect(await read(root, "packages/api/CLAUDE.md")).toBe(USER_NESTED_CLAUDE);

    // The area's knowledge is a path-scoped rule Claude loads when work enters packages/api.
    const area = await read(root, ".claude/rules/pathrule/packages-api.md");
    expect(area).toContain('paths:\n  - "packages/api/**"');
    expect(area).toContain("API rule");
  });

  it("leaves the user's root CLAUDE.md alone (bespoke pipeline owns it)", async () => {
    const root = await makeBrownfieldRepo();
    await sync(root, ["claude-code"]);
    // renderForClients skips the root CLAUDE.md for claude-code by design.
    expect(await read(root, "CLAUDE.md")).toBe(USER_ROOT_CLAUDE);
  });
});

describe("brownfield sync: user's AGENTS.md", () => {
  it("keeps the cross-runtime standard file intact and merges a region into it", async () => {
    const root = await makeBrownfieldRepo();
    const res = await sync(root, ["codex"]);

    expect(res.backedUp).toEqual([]);
    const live = await read(root, "AGENTS.md");
    // The user's instruction still reaches every agent that reads AGENTS.md
    // (Codex, OpenCode, Antigravity, Grok, Kimi, Gemini CLI).
    expect(live).toContain("Run `pnpm test` before every commit.");
    expect(live).toContain("Pathrule managed");
    expect(stripRegion(live!)).toBe(USER_AGENTS.trim());
  });
});

describe("brownfield sync: idempotency", () => {
  it("second sync with identical input writes nothing and backs nothing up", async () => {
    const root = await makeBrownfieldRepo();
    await sync(root, ["claude-code", "codex"]);
    const second = await sync(root, ["claude-code", "codex"]);

    expect(second.written).toBe(0);
    expect(second.backedUp).toEqual([]);
    expect(second.removed).toBe(0);
  });
});

describe("brownfield sync: marker asymmetry (regression)", () => {
  it("recognises its own root-protocol body at a nested path instead of treating it as the user's", async () => {
    const root = await makeBrownfieldRepo();
    await sync(root, ["claude-code"]);

    // Simulate what a second Pathrule writer (e.g. a nested workspace bound at
    // packages/api) leaves behind: the ROOT protocol banner, whose spelling
    // ("managed by Pathrule") differs from the knowledge banner's
    // ("Pathrule managed"). Recognising only one spelling is what grew
    // packages/mobile to backup.CLAUDE.md.6.
    await writeFile(
      join(root, "packages", "api", "CLAUDE.md"),
      "<!-- managed by Pathrule — do not edit this file manually. -->\n\n# Pathrule Workspace\n",
      "utf8",
    );

    const res = await sync(root, ["claude-code"]);

    // It is ours (it opens with Pathrule's banner), so it goes: no backup, no preserved remnant.
    expect(res.backedUp).toEqual([]);
    expect(await read(root, "packages/api/CLAUDE.md")).toBeNull();
  });

  it("never takes a person's file for its own because the file quotes a banner", async () => {
    const root = await makeBrownfieldRepo();
    const quoting = "# API package\n\nOld syncs wrote `<!-- managed by Pathrule -->` here; keep this note.\n";
    await writeFile(join(root, "packages", "api", "CLAUDE.md"), quoting, "utf8");
    await sync(root, ["claude-code"]);
    expect(await read(root, "packages/api/CLAUDE.md")).toBe(quoting);
  });

  it("produces no backup files at all, no matter how many syncs run", async () => {
    const root = await makeBrownfieldRepo();
    for (let i = 0; i < 5; i += 1) await sync(root, ["claude-code", "codex"]);

    // The whole point: the working tree never accumulates clutter, and the
    // backup vault is never even created because nothing needs moving aside.
    // (`.pathrule/` itself exists — it holds the managed-file ownership ledger.)
    expect(await read(root, ".pathrule/backups/AGENTS.md")).toBeNull();
    expect(await readdir(join(root, ".pathrule"))).toEqual(["managed-files.json"]);
    const rootEntries = await readdir(root);
    expect(rootEntries.filter((e) => e.startsWith("backup."))).toEqual([]);

    // And the user's content is still there after five rounds.
    expect(await read(root, "AGENTS.md")).toContain("Run `pnpm test` before every commit.");
    expect(await read(root, "packages/api/CLAUDE.md")).toContain("Node 20 only");
  });
});

describe("brownfield sync: sweep retracts, it does not destroy", () => {
  it("takes an earlier Pathrule's region back out of the person's nested CLAUDE.md", async () => {
    const root = await makeBrownfieldRepo();
    // What an earlier Pathrule left: the person's file with a knowledge region appended.
    await writeFile(
      join(root, "packages", "api", "CLAUDE.md"),
      `${USER_NESTED_CLAUDE}\n<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\n<!-- Pathrule managed (knowledge) -->\n### API rule\nValidate input.\n<!-- pathrule:end -->\n`,
      "utf8",
    );
    await sync(root, ["claude-code"]);

    // The person's file is exactly theirs again; the knowledge lives in Pathrule's own file.
    expect(await read(root, "packages/api/CLAUDE.md")).toBe(USER_NESTED_CLAUDE);
    expect(await read(root, ".claude/rules/pathrule/packages-api.md")).toContain("API rule");
  });

  it("deletes a file that was entirely Pathrule's", async () => {
    const root = await makeBrownfieldRepo();
    await mkdir(join(root, "packages", "web"), { recursive: true });

    // The overview stays the same in both rounds — that is what makes the path
    // "owned" and therefore a sweep candidate. Only the knowledge disappears.
    const overview = [
      { node_id: "n1", relative_path: "/packages/api", memories: [], rules: [], skills: [] },
      { node_id: "n2", relative_path: "/packages/web", memories: [], rules: [], skills: [] },
    ];
    const webKnowledge: CompiledKnowledgeNode = {
      dir_path: "/packages/web",
      markdown: "> Authoritative...\n\n## Rules (must follow)\n\n### Web rule\nReact 19.\n",
      memory_ids: [],
      rule_ids: ["r-web"],
      skill_ids: [],
      truncated: false,
    };

    // packages/web has no user file, so Pathrule's knowledge file stands alone.
    const withWeb = baseInput({
      overview,
      knowledge: [...KNOWLEDGE, webKnowledge],
      knowledgeSlim: [...KNOWLEDGE, webKnowledge],
    });
    // An earlier Pathrule's whole-file knowledge at packages/web/CLAUDE.md (a region, nothing else).
    await writeFile(
      join(root, "packages", "web", "CLAUDE.md"),
      "<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\n<!-- Pathrule managed (knowledge) -->\n### Web rule\n<!-- pathrule:end -->\n",
      "utf8",
    );
    await sync(root, ["claude-code"], withWeb);
    expect(await read(root, "packages/web/CLAUDE.md")).toBeNull();
    expect(await read(root, ".claude/rules/pathrule/packages-web.md")).toContain("Web rule");

    // Knowledge for /packages/web disappears → Pathrule's file for it goes.
    await sync(root, ["claude-code"], baseInput({ overview }));
    expect(await read(root, ".claude/rules/pathrule/packages-web.md")).toBeNull();
  });
});

describe("brownfield sync: sweep safety", () => {
  it("does not delete a user-authored file sitting at an owned path", async () => {
    const root = await makeBrownfieldRepo();
    // A directory Pathrule claims in ownedPaths (from overview) but has no
    // knowledge for, holding a user file.
    await mkdir(join(root, "packages", "web"), { recursive: true });
    await writeFile(join(root, "packages", "web", "CLAUDE.md"), "# user web notes\n", "utf8");

    const input = baseInput({
      overview: [
        { node_id: "n1", relative_path: "/packages/api", memories: [], rules: [], skills: [] },
        { node_id: "n2", relative_path: "/packages/web", memories: [], rules: [], skills: [] },
      ],
    });
    await sync(root, ["claude-code"], input);

    expect(await read(root, "packages/web/CLAUDE.md")).toBe("# user web notes\n");
  });
});

describe("gathered input: no work is done for fields nobody reads", () => {
  // `rootContext` and `recentActivities` were gathered on every rerender — a
  // get_context call plus an activities read, in BOTH the local and the cloud
  // edition — and changed zero rendered bytes. They are gone from
  // MultiClientInput, so the type now prevents re-adding the field; this guards
  // the other half, the queries that fed it.
  it("neither gather calls get_context or reads activities", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = import.meta.dirname;

    // The cloud edition's gather (orchestrator-cloud.ts) is pinned the same way beside it, in @pathrule/shared.
    for (const file of ["orchestrator.ts"]) {
      const source = readFileSync(join(dir, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} should not call getContextHandler`).not.toContain("getContextHandler(");
      expect(code, `${file} should not read recent activities`).not.toMatch(
        /recentActivities\s*\(|from\("activity_logs"\)/,
      );
    }
  });

  it("renders identical bytes from the minimal input", () => {
    const once = renderForClients(baseInput(), ["claude-code", "codex"]);
    const twice = renderForClients(baseInput(), ["claude-code", "codex"]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
