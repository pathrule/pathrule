// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareSemverish,
  forgetManagedFileOwnership,
  managedFileOwnershipManifestPath,
  readManagedFileOwnershipManifest,
  recordManagedFileOwnership,
  summarizeManagedFileOwnership,
} from "./managed-file-ownership.js";

async function withTempWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pathrule-managed-files-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("managed file ownership", () => {
  it("records, updates, and forgets normalized managed paths", async () => {
    await withTempWorkspace(async (root) => {
      await recordManagedFileOwnership({
        workspaceRoot: root,
        paths: ["AGENTS.md", ".cursor/../.cursorrules"],
        owner: "cli",
        ownerVersion: "1.2.3",
        now: new Date("2026-05-13T00:00:00.000Z"),
      });
      await recordManagedFileOwnership({
        workspaceRoot: root,
        paths: ["AGENTS.md"],
        owner: "desktop",
        ownerVersion: "1.2.4",
        now: new Date("2026-05-13T01:00:00.000Z"),
      });

      const manifest = await readManagedFileOwnershipManifest(root);
      expect(manifest.files).toEqual([
        {
          path: ".cursorrules",
          owner: "cli",
          owner_version: "1.2.3",
          updated_at: "2026-05-13T00:00:00.000Z",
        },
        {
          path: "AGENTS.md",
          owner: "desktop",
          owner_version: "1.2.4",
          updated_at: "2026-05-13T01:00:00.000Z",
        },
      ]);

      await forgetManagedFileOwnership({ workspaceRoot: root, paths: [".cursorrules"] });
      await expect(readManagedFileOwnershipManifest(root)).resolves.toMatchObject({
        files: [{ path: "AGENTS.md" }],
      });
      expect(managedFileOwnershipManifestPath(root)).toBe(
        join(root, ".pathrule", "managed-files.json"),
      );
    });
  });

  it("summarizes other-owner and version skew warnings", () => {
    const summary = summarizeManagedFileOwnership(
      {
        schema_version: 1,
        files: [
          { path: "AGENTS.md", owner: "desktop", owner_version: "1.2.4", updated_at: "now" },
          { path: "CLAUDE.md", owner: "cli", owner_version: "1.2.4", updated_at: "now" },
          { path: ".cursorrules", owner: "cli", owner_version: "1.2.2", updated_at: "now" },
        ],
      },
      "cli",
      "1.2.3",
    );

    expect(summary.map((entry) => [entry.path, entry.status])).toEqual([
      ["AGENTS.md", "other_owner"],
      ["CLAUDE.md", "newer_version"],
      [".cursorrules", "older_version"],
    ]);
  });

  it("compares semver-like versions without requiring strict semver", () => {
    expect(compareSemverish("0.4.8", "0.4.7")).toBe(1);
    expect(compareSemverish("pathrule 0.4.7", "0.4.7")).toBe(0);
    expect(compareSemverish("0.4.6", "0.4.7")).toBe(-1);
  });
});
