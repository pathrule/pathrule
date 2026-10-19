// SPDX-License-Identifier: Apache-2.0
// End-to-end recovery scan against a real directory shaped like a repo that an
// OLDER Pathrule already damaged.

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planRecovery, scanForRecovery } from "./recovery-scan.js";

const KNOWLEDGE_BANNER = "<!-- Pathrule managed (knowledge) — do not edit. -->";

/** A repo an older Pathrule took files over in. */
async function makeDamagedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pathrule-recovery-"));
  const put = async (rel: string, body: string) => {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  };

  // Root: the user's file was taken over, their content sits in a stray backup.
  await put("backup.CLAUDE.md", "# Acme\n\nSee @docs/architecture.md.\n");
  await put("CLAUDE.md", "<!-- managed by Pathrule -->\n# Pathrule Workspace\n");

  // A package where the pileup happened (the marker-asymmetry bug).
  await put("packages/mobile/backup.CLAUDE.md", "# Mobile\n\nXcode 16 only.\n");
  await put("packages/mobile/backup.CLAUDE.md.1", "# Mobile\n\nXcode 16 only.\n");
  await put("packages/mobile/CLAUDE.md", `${KNOWLEDGE_BANNER}\n# Project knowledge\n`);

  // The malformed dotfile name.
  await put("backup..cursorrules", "Always TypeScript strict.\n");

  // An interim vault entry.
  await put(".pathrule/backups/AGENTS.md", "# Team\n\nRun pnpm test.\n");
  await put(".pathrule/managed-files.json", "{}\n");

  // Noise that must be ignored.
  await put("node_modules/pkg/backup.CLAUDE.md", "should be skipped\n");
  await put("docs/backup.notes.md", "not an instruction file\n");
  await put("scripts/backup.sh", "#!/bin/sh\n");
  await put("src/index.ts", "export {};\n");

  return root;
}

describe("scanForRecovery", () => {
  it("reads leftovers and live instruction files, skipping noise", async () => {
    const root = await makeDamagedRepo();
    const paths = (await scanForRecovery(root)).map((f) => f.path).sort();

    expect(paths).toContain("backup.CLAUDE.md");
    expect(paths).toContain("backup..cursorrules");
    expect(paths).toContain("packages/mobile/backup.CLAUDE.md.1");
    expect(paths).toContain(".pathrule/backups/AGENTS.md");
    expect(paths).toContain("CLAUDE.md"); // live file, needed for the verdict

    // Skipped: vendored dirs and non-instruction lookalikes.
    expect(paths).not.toContain("node_modules/pkg/backup.CLAUDE.md");
    expect(paths).not.toContain("src/index.ts");
  });
});

describe("planRecovery", () => {
  it("reports every leftover with where it came from", async () => {
    const root = await makeDamagedRepo();
    const plan = await planRecovery(root);

    const summary = plan.leftovers.map((l) => [l.path, l.restoresTo]).sort();
    expect(summary).toEqual(
      [
        [".pathrule/backups/AGENTS.md", "AGENTS.md"],
        ["backup..cursorrules", ".cursorrules"],
        ["backup.CLAUDE.md", "CLAUDE.md"],
        ["packages/mobile/backup.CLAUDE.md", "packages/mobile/CLAUDE.md"],
        ["packages/mobile/backup.CLAUDE.md.1", "packages/mobile/CLAUDE.md"],
      ].sort(),
    );
  });

  it("marks all of them restorable, since the live files hold nothing of the user's", async () => {
    const root = await makeDamagedRepo();
    const plan = await planRecovery(root);
    expect(plan.needsChoice).toEqual([]);
    expect(plan.restorable).toHaveLength(plan.leftovers.length);
  });

  it("returns an empty plan for a repo the new writers produced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-clean-"));
    await writeFile(
      join(root, "CLAUDE.md"),
      "# Acme\n\nUse pnpm.\n\n<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\nSECTION\n<!-- pathrule:end -->\n",
      "utf8",
    );
    const plan = await planRecovery(root);
    expect(plan.leftovers).toEqual([]);
  });

  it("needs a human choice when the user has since written in the live file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pathrule-mixed-"));
    await writeFile(join(root, "backup.AGENTS.md"), "# Old team notes\n", "utf8");
    await writeFile(
      join(root, "AGENTS.md"),
      "# New team notes\n\n<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->\nSECTION\n<!-- pathrule:end -->\n",
      "utf8",
    );

    const plan = await planRecovery(root);
    expect(plan.needsChoice).toHaveLength(1);
    expect(plan.restorable).toEqual([]);
  });
});
