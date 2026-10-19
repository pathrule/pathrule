// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readReviewHistory,
  verifyReviewEvidence,
  repositoryFromRemote,
  type ReviewRequest,
} from "./review-history.js";
import { projectMapPath } from "./store.js";
import { createLearningClaim, loadLearningContext } from "./claim-service.js";
import { parseLearningClaim } from "./claims.js";

const exec = promisify(execFile);
const roots: string[] = [];
const repository = "team/project";
const now = Date.parse("2026-09-28T10:00:00Z");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-root-")));
  const home = await realpath(await mkdtemp(join(tmpdir(), "review-home-")));
  roots.push(root, home);
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["remote", "add", "origin", "https://github.com/team/project.git"], {
    cwd: root,
  });
  return { workspaceId: "ws", localRootPath: root, env: { PATHRULE_HOME: home } };
}
const pull = (number = 1) => ({
  number,
  merged_at: "2026-09-20T00:00:00Z",
  base: { repo: { full_name: repository } },
});
const review = (id = 11, body = "Keep storage behind an adapter.") => ({
  id,
  body,
  user: { type: "User", login: "private-person" },
  state: "COMMENTED",
  author_association: "MEMBER",
  commit_id: "a".repeat(40),
});
function responses(
  options: { pulls?: unknown[]; reviews?: unknown[]; comments?: unknown[] } = {},
): ReviewRequest {
  return async (endpoint) => {
    if (endpoint.includes("/reviews?")) return options.reviews ?? [review()];
    if (endpoint.includes("/comments?")) return options.comments ?? [];
    if (endpoint.includes("/pulls?")) return options.pulls ?? [pull()];
    return pull(Number(endpoint.split("/").pop()));
  };
}

describe("bounded PR learning evidence", () => {
  it("accepts only a fixed GitHub repository identity", () => {
    expect(repositoryFromRemote("git@github.com:Team/Project.git")).toBe(repository);
    for (const remote of [
      "https://github.com.evil/team/project",
      "https://github.com/team/project?token=x",
      "https://token@github.com/team/project",
      "-evil",
      "https://github.com/team/../project",
    ])
      expect(repositoryFromRemote(remote)).toBeNull();
  });

  it("stores metadata outside the repo, verifies receipts and omits known excerpts on incremental refresh", async () => {
    const options = await fixture();
    const first = await readReviewHistory(options, { request: responses(), now: () => now });
    expect(first).toMatchObject({ status: "available", phase: "initial", persisted: true });
    const source = first.evidence[0]!.source;
    expect(await verifyReviewEvidence(options, [source], { now })).toBe("current");
    const cache = dirname((await projectMapPath("ws", options.localRootPath, options.env))!);
    const stored = await readFile(join(cache, (await readdir(cache))[0]!), "utf8");
    expect(stored).not.toContain("Keep storage");
    expect(stored).not.toContain("private-person");
    expect(await readdir(options.localRootPath)).toEqual([".git"]);
    const second = await readReviewHistory(
      { ...options, knownDigests: [source.digest] },
      { request: responses(), now: () => now + 10 },
    );
    expect(second).toMatchObject({ phase: "incremental", evidence: [], unchanged: 1 });
  });

  it("invalidates changed, deleted and dismissed evidence without changing shared claims", async () => {
    const options = await fixture();
    const first = await readReviewHistory(options, { request: responses(), now: () => now });
    const source = first.evidence[0]!.source;
    await readReviewHistory(options, {
      request: responses({ reviews: [review(11, "Changed opinion")] }),
      now: () => now,
    });
    expect(await verifyReviewEvidence(options, [source], { now })).toBe("stale");
    await readReviewHistory(options, {
      request: responses({ reviews: [{ ...review(), state: "DISMISSED" }] }),
      now: () => now,
    });
    expect(await verifyReviewEvidence(options, [source], { now })).toBe("unknown");
    await readReviewHistory(options, { request: responses({ reviews: [] }), now: () => now });
    expect(await verifyReviewEvidence(options, [source], { now })).toBe("unknown");
  });

  it("excludes bots, external authors, pending reviews and comments whose parent review is not active", async () => {
    const options = await fixture();
    const result = await readReviewHistory(options, {
      request: responses({
        reviews: [
          review(),
          { ...review(12), user: { type: "Bot" } },
          { ...review(13), author_association: "NONE" },
          { ...review(14), state: "PENDING" },
          { ...review(15), state: "DISMISSED" },
        ],
        comments: [
          { ...review(22), path: "src/a.ts", pull_request_review_id: 15 },
          { ...review(23), path: "src/a.ts", pull_request_review_id: 11 },
        ],
      }),
      now: () => now,
    });
    expect(result.evidence.map((e) => e.source.id)).toEqual([11, 23]);
    expect(result.evidence[1]?.url).toBe("https://github.com/team/project/pull/1#discussion_r23");
  });

  it("does not treat API failures, unsupported remotes, expired receipts or another checkout as no history", async () => {
    const options = await fixture();
    const first = await readReviewHistory(options, { request: responses(), now: () => now });
    const source = first.evidence[0]!.source;
    expect(await verifyReviewEvidence(options, [source], { now: now + 86400001 })).toBe("unknown");
    expect(await verifyReviewEvidence(options, [source], { repository: "team/other", now })).toBe(
      "unknown",
    );
    const failed = await readReviewHistory(
      { ...options, pullNumbers: [1] },
      {
        request: async () => {
          throw new Error("403");
        },
        now: () => now,
      },
    );
    expect(failed).toMatchObject({ status: "unavailable", reason: "github_unavailable" });
    expect(await verifyReviewEvidence(options, [source], { now })).toBe("unknown");
    expect((await readReviewHistory(options, { repository: null })).reason).toBe(
      "unsupported_remote",
    );
  });

  it("bounds PR calls and excerpt size and reports partial pagination", async () => {
    const options = await fixture();
    const calls: string[] = [];
    const request = responses({
      pulls: Array.from({ length: 10 }, (_, i) => pull(i + 1)),
      reviews: Array.from({ length: 100 }, (_, i) => review(i + 1, "z".repeat(2000))),
    });
    const result = await readReviewHistory(options, {
      request: async (endpoint) => {
        calls.push(endpoint);
        return request(endpoint);
      },
    });
    expect(calls).toHaveLength(7);
    expect(result.status).toBe("partial");
    expect(result.nextPage).toBe(2);
    expect(result.evidence.reduce((sum, e) => sum + e.excerpt.length, 0)).toBeLessThanOrEqual(9000);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.evidence.every((e) => e.truncated)).toBe(true);
  });

  it("requires multiple PRs for convention hypotheses and withholds them when local review verification expires", async () => {
    const options = await fixture();
    const history = await readReviewHistory(options, {
      request: responses({ pulls: [pull(1), pull(2)] }),
    });
    const refs = history.evidence.map((e) => e.source);
    const body = "export const adapter = true;";
    await writeFile(join(options.localRootPath, "store.ts"), body);
    const input = {
      workspaceId: "ws",
      nodePath: "/",
      topic: "Storage",
      category: "convention" as const,
      statement: "Two reviews favor an adapter for storage; treat this as a hypothesis.",
      sources: [
        { path: "store.ts", digest: `sha256:${createHash("sha256").update(body).digest("hex")}` },
      ],
      reviewSources: refs,
    };
    expect(() => createLearningClaim({ ...input, reviewSources: refs.slice(0, 1) })).toThrow();
    const claim = createLearningClaim(input);
    expect(parseLearningClaim(claim)?.reviewSources).toEqual(refs);
    const portable = parseLearningClaim({
      ...claim,
      reviewSources: refs.map((source) => ({
        ...source,
        body: "private raw comment",
        author: "private-person",
      })),
    });
    expect(JSON.stringify(portable)).not.toContain("private raw comment");
    expect(JSON.stringify(portable)).not.toContain("private-person");
    const contextOptions = {
      ...options,
      backend: { listLearningClaims: async () => [claim] },
    };
    expect((await loadLearningContext(contextOptions)).claims).toEqual([claim]);
    await readReviewHistory(options, {
      request: responses({ pulls: [pull(1), pull(2)] }),
      now: () => Date.now() - 86400001,
    });
    const stale = await loadLearningContext(contextOptions);
    expect(stale.claims).toEqual([]);
    expect(stale.withheld[0]?.reviewUrls).toHaveLength(2);
  });

  it("refuses internal storage configured inside the customer checkout", async () => {
    const options = await fixture();
    let called = false;
    const result = await readReviewHistory(
      { ...options, env: { PATHRULE_HOME: join(options.localRootPath, "cache") } },
      {
        request: async () => {
          called = true;
          return [];
        },
      },
    );
    expect(result.reason).toBe("storage_unavailable");
    expect(called).toBe(false);
    expect(await readdir(options.localRootPath)).toEqual([".git"]);
  });
});
