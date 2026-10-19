// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { InMemoryKnowledgeBackend } from "../in-memory-backend.js";
import { createLearningClaim } from "../../project-learning/claim-service.js";

describe.each(["sqlite", "memory"])("learning claims: %s", (kind) => {
  it("atomically revises, preserves retirement on replay and rejects conflicting corrections", async () => {
    const backend =
      kind === "sqlite" ? new LocalBackend(":memory:") : new InMemoryKnowledgeBackend();
    try {
      const original = createLearningClaim({
        workspaceId: "one",
        nodePath: "/src",
        topic: "Storage",
        category: "architecture",
        statement: "Initial finding.",
        sources: [{ path: "src/store.ts", digest: `sha256:${"a".repeat(64)}` }],
      });
      const replacement = createLearningClaim({ ...original, statement: "Corrected finding." });
      const alternate = createLearningClaim({ ...original, statement: "Concurrent correction." });
      await backend.putLearningClaim(original);
      const input = { workspaceId: "one", id: original.id, replacement };
      const attempts = await Promise.allSettled([
        backend.reviseLearningClaim(input),
        backend.reviseLearningClaim({ ...input, replacement: alternate }),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual(["fulfilled", "rejected"]);
      await backend.reviseLearningClaim(input);
      expect(await backend.listLearningClaims("one")).toEqual([replacement]);
      await expect(backend.putLearningClaim(original)).rejects.toMatchObject({ code: "23514" });
      await expect(
        backend.reviseLearningClaim({ ...input, replacement: alternate }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await backend.listLearningClaims("one")).toEqual([replacement]);
      await backend.reviseLearningClaim({ workspaceId: "one", id: replacement.id });
      expect(await backend.listLearningClaims("one")).toEqual([]);
      await expect(backend.putLearningClaim(replacement)).rejects.toMatchObject({ code: "23514" });
      await expect(
        backend.reviseLearningClaim({
          ...input,
          replacement: { ...alternate, workspaceId: "other" },
        }),
      ).rejects.toThrow("same workspace");
    } finally {
      if (backend instanceof LocalBackend) backend.close();
    }
  });

  it("preserves the original on replay, isolates workspace identity and survives mutation of the returned value", async () => {
    const backend =
      kind === "sqlite" ? new LocalBackend(":memory:") : new InMemoryKnowledgeBackend();
    try {
      const claim = createLearningClaim({
        workspaceId: "one",
        nodePath: "/src",
        topic: "Storage",
        category: "architecture",
        reviewSources: [
          {
            repository: "team/project",
            pullRequest: 4,
            kind: "review",
            id: 12,
            digest: `sha256:${"b".repeat(64)}`,
            commit: "a".repeat(40),
            mergedAt: "2026-09-20T00:00:00Z",
            association: "MEMBER",
            state: "COMMENTED",
          },
        ],
        statement: "Storage lives in this module.",
        sources: [{ path: "src/store.ts", digest: `sha256:${"a".repeat(64)}` }],
      });
      await expect(
        backend.putLearningClaim({
          ...claim,
          statement: "界".repeat(1200),
          sources: Array.from({ length: 6 }, (_, i) => ({
            path: `src/${"界".repeat(490)}${i}.ts`,
            digest: `sha256:${"a".repeat(64)}`,
          })),
        }),
      ).rejects.toMatchObject({ code: "22001" });
      expect(await backend.listLearningClaims("one")).toEqual([]);
      const first = await backend.putLearningClaim(claim);
      first.sources[0]!.path = "mutated.ts";
      const replay = await backend.putLearningClaim({ ...claim, statement: "must not overwrite" });
      expect(replay.statement).toBe(claim.statement);
      expect(replay.sources[0]?.path).toBe("src/store.ts");
      expect(await backend.listLearningClaims("two")).toEqual([]);
      expect(await backend.listLearningClaims("one")).toEqual([claim]);
      await expect(backend.putLearningClaim({ ...claim, statement: "" })).rejects.toThrow();
    } finally {
      if (backend instanceof LocalBackend) backend.close();
    }
  });
});

it("persists retirement across a SQLite restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "learning-lifecycle-"));
  let backend = new LocalBackend(join(dir, "knowledge.sqlite"));
  try {
    const claim = createLearningClaim({
      workspaceId: "ws",
      nodePath: "/src",
      topic: "Storage",
      category: "architecture",
      statement: "Old finding.",
      sources: [{ path: "src/a.ts", digest: `sha256:${"a".repeat(64)}` }],
    });
    await backend.putLearningClaim(claim);
    await backend.reviseLearningClaim({ workspaceId: "ws", id: claim.id });
    backend.close();
    backend = new LocalBackend(join(dir, "knowledge.sqlite"));
    expect(await backend.listLearningClaims("ws")).toEqual([]);
    await expect(backend.putLearningClaim(claim)).rejects.toMatchObject({ code: "23514" });
    expect(await backend.retiredLearningClaimIds("ws", [claim.id])).toEqual([claim.id]);
  } finally {
    backend.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("skips an unreadable local row instead of hiding every other claim", async () => {
  const backend = new LocalBackend(":memory:");
  try {
    const claim = createLearningClaim({
      workspaceId: "ws",
      nodePath: "/src",
      topic: "Storage",
      category: "architecture",
      statement: "Kept finding.",
      sources: [{ path: "src/a.ts", digest: `sha256:${"a".repeat(64)}` }],
    });
    await backend.putLearningClaim(claim);
    // A corrupt cell and a row that fails the contract, written the way an older build or a
    // hand edit would leave them.
    const db = (
      backend as unknown as { db: { prepare(sql: string): { run(...v: unknown[]): void } } }
    ).db;
    const insert = db.prepare(
      "INSERT INTO learning_claims (workspace_id, id, claim, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("ws", "b".repeat(64), "{not json", "2026-01-01T00:00:00.000Z");
    insert.run(
      "ws",
      "c".repeat(64),
      JSON.stringify({ ...claim, origin: "other" }),
      "2026-01-01T00:00:00.000Z",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await backend.listLearningClaims("ws")).toEqual([claim]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  } finally {
    backend.close();
  }
});
