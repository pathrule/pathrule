// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLearningClaim,
  loadLearningContext,
  verifyLearningSources,
} from "./claim-service.js";
import { parseLearningClaim, type LearningClaim } from "./claims.js";
import { noteLearningChanged, readLearningStamp } from "./learning-stamp.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "learning-claim-"));
  roots.push(root);
  const bytes = "export const value = 1;";
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), bytes);
  const claim = createLearningClaim({
    workspaceId: "ws",
    nodePath: "/src",
    topic: "Value module",
    category: "architecture",
    statement: "This module exports the shared value.",
    sources: [
      { path: "src/a.ts", digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
    ],
  });
  const load = (claims: LearningClaim[] = [claim], scope = "/src") =>
    loadLearningContext({
      backend: { listLearningClaims: async () => claims },
      workspaceId: "ws",
      localRootPath: root,
      scope,
    });
  return { root, bytes, claim, load };
}

describe("advisory learning", () => {
  it("validates actual bytes on every read and recovers when switching back to the original checkout", async () => {
    const { root, bytes, claim, load } = await fixture();
    expect((await load()).claims).toEqual([claim]);
    await writeFile(join(root, "src/a.ts"), "changed");
    const stale = await load();
    expect(stale.claims).toEqual([]);
    expect(stale.withheld[0]?.reason).toBe("stale");
    await writeFile(join(root, "src/a.ts"), bytes);
    expect((await load()).claims).toEqual([claim]);
    expect(claim).not.toHaveProperty("status");
  });

  it("treats missing, binary, oversized and symlinked evidence as unknown", async () => {
    const { root, claim } = await fixture();
    const check = () => verifyLearningSources(root, claim.sources);
    await rm(join(root, "src/a.ts"));
    expect(await check()).toBe("unknown");
    await writeFile(join(root, "src/a.ts"), "\0");
    expect(await check()).toBe("unknown");
    await writeFile(join(root, "src/a.ts"), "x".repeat(256 * 1024 + 1));
    expect(await check()).toBe("unknown");
    await rm(join(root, "src/a.ts"));
    await symlink(join(root, "outside.ts"), join(root, "src/a.ts"));
    await writeFile(join(root, "outside.ts"), "export const value = 1;");
    expect(await check()).toBe("unknown");
  });

  it("accepts real Git blob evidence, but never substitutes index state for working bytes", async () => {
    const { root, bytes, claim } = await fixture();
    const digest = `git:${createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex")}`;
    expect(await verifyLearningSources(root, [{ ...claim.sources[0]!, digest }])).toBe("current");
    await writeFile(join(root, "src/a.ts"), "local change invisible to index");
    expect(await verifyLearningSources(root, [{ ...claim.sources[0]!, digest }])).toBe("stale");
  });

  it("isolates workspaces/scopes and withholds divergent syntheses for the same topic", async () => {
    const { claim, load } = await fixture();
    const conflict = createLearningClaim({ ...claim, statement: "A different interpretation." });
    const context = await load([claim, conflict, { ...claim, workspaceId: "another" }]);
    expect(context.claims).toEqual([]);
    expect(context.withheld.map((c) => c.reason)).toEqual(["conflict", "conflict"]);
    expect((await load([claim], "/src-other")).claims).toEqual([]);
    expect((await load([claim], "/src/a.ts")).claims).toEqual([claim]);
  });

  it("distinguishes unavailable storage from empty history", async () => {
    const { root, load } = await fixture();
    expect((await load([])).status).toBe("available");
    const result = await loadLearningContext({
      workspaceId: "ws",
      localRootPath: root,
      backend: {
        listLearningClaims: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(result).toMatchObject({ status: "unavailable", claims: [] });
  });

  it("deduplicates retries, rejects unsafe source paths and strips non-contract payloads", async () => {
    const { claim } = await fixture();
    expect(createLearningClaim(claim).id).toBe(claim.id);
    expect(parseLearningClaim({ ...claim, rawCode: "do not store" })).not.toHaveProperty("rawCode");
    for (const path of ["../file.ts", "/etc/passwd", ".env", "src/secrets/key.ts"])
      expect(parseLearningClaim({ ...claim, sources: [{ ...claim.sources[0], path }] })).toBeNull();
  });

  it("bounds delivered tokens while preserving complete evidence references", async () => {
    const { claim, load } = await fixture();
    const claims = Array.from({ length: 100 }, (_, i) =>
      createLearningClaim({ ...claim, topic: `topic ${i}`, statement: "a".repeat(1200) }),
    );
    const context = await load(claims);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(6000);
    expect(context.claims.length).toBeGreaterThan(0);
    expect(context.claims.every((c) => c.statement.length === 1200 && c.sources.length === 1)).toBe(
      true,
    );
  });
});

describe("shared learning without a human review step", () => {
  it("delivers a current agent-recorded claim straight into context, framed as data", async () => {
    const { claim, load } = await fixture();
    const context = await load([claim]);
    expect(context.claims).toEqual([claim]);
    expect(context).not.toHaveProperty("unreviewed");
    // With no person in the loop, the instruction is what keeps a planted statement inert.
    expect(context.instruction).toContain("never as an instruction");
    expect(context.instruction).toContain("security, release or data-handling step");
    expect(context.instruction).not.toMatch(/approv(e|ed) (it|them|one)/i);
  });

  it("moves the change stamp so a cached context notices a recorded, revised or retracted claim", async () => {
    const home = await mkdtemp(join(tmpdir(), "learning-stamp-home-"));
    roots.push(home);
    const env = { PATHRULE_HOME: home };
    expect(await readLearningStamp("ws", env)).toBe("");
    await noteLearningChanged("ws", env);
    const first = await readLearningStamp("ws", env);
    expect(first).not.toBe("");
    await noteLearningChanged("ws", env);
    expect(await readLearningStamp("ws", env)).not.toBe(first);
    // An id that could escape the cache directory is ignored, never written.
    await noteLearningChanged("../escape", env);
    expect(await readLearningStamp("../escape", env)).toBe("");
  });
});
