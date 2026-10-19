// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { syncSkillsToDisk, type SkillForMaterialize } from "./materializer.js";
import { slugifySkillName } from "./slug.js";

const SKILL: SkillForMaterialize = {
  id: "99e1c249-ecb9-41c8-b06b-5252cecdeb50",
  name: "milestone-plan-author",
  description: "Write new Pathrule milestone implementation plans.",
  content: "---\nname: milestone-plan-author\ndescription: x\n---\n\n# Body\n",
  source: "manual",
  githubUrl: null,
  contentFetchedAt: null,
};

describe("syncSkillsToDisk idempotency", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pathrule-materializer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes SKILL.md on the first run and skips the unchanged file on the second", async () => {
    const first = await syncSkillsToDisk({
      workspaceRoot: root,
      activeTargets: ["claude-code"],
      skills: [SKILL],
    });
    expect(first.written).toBe(1);
    expect(first.errors).toEqual([]);

    const onDisk = await readFile(
      join(root, ".claude/skills/milestone-plan-author/SKILL.md"),
      "utf8",
    );
    expect(onDisk).toContain("milestone-plan-author");

    const second = await syncSkillsToDisk({
      workspaceRoot: root,
      activeTargets: ["claude-code"],
      skills: [SKILL],
    });
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

// The manifest lives in the workspace (`.claude/.pathrule-skills-manifest.json`), so a cloned
// repository can ship one. Its slugs used to be trusted: `rm -rf <skills>/<slug>` and writes under
// `<skills>/<slug>/` ran with whatever path a slug spelled.
describe("a manifest from the repository cannot reach outside the skills folder", () => {
  let base: string;
  let root: string;
  let victim: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "pathrule-materializer-escape-"));
    root = join(base, "repo");
    victim = join(base, "victim");
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep.txt"), "mine");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function plantManifest(slug: string, id = "planted-id") {
    await writeFile(
      join(root, ".claude/.pathrule-skills-manifest.json"),
      JSON.stringify({
        version: 2,
        skills: { [id]: { slug, hash: "x", source: "manual", fetchedAt: null, targets: ["claude-code"] } },
      }),
    );
  }

  it("does not delete a folder a planted slug points at", async () => {
    await plantManifest("../../../victim");
    await syncSkillsToDisk({ workspaceRoot: root, activeTargets: ["claude-code"], skills: [] });
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("mine");
  });

  it("does not write a live skill where a planted slug points", async () => {
    await plantManifest("../../../victim", SKILL.id);
    const result = await syncSkillsToDisk({
      workspaceRoot: root,
      activeTargets: ["claude-code"],
      skills: [SKILL],
    });
    expect(result.errors).toEqual([]);
    await expect(stat(join(victim, "SKILL.md"))).rejects.toThrow();
    expect(await readFile(join(root, ".claude/skills/milestone-plan-author/SKILL.md"), "utf8")).toContain(
      "milestone-plan-author",
    );
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("mine");
  });

  it("never produces a slug its own manifest would refuse", () => {
    expect(slugifySkillName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });
});
