// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { resolveHandler } from "./resolve.js";
import type { ToolContext } from "./types.js";

// A minimal backend stub exposing only what resolveHandler touches:
// workspaceOverview (titles + ids, no bodies) + the per-kind reads it uses to
// attach a version_id for a single unambiguous winner.
function makeCtx(): ToolContext {
  const overview = [
    {
      node_id: "n-root",
      relative_path: "/",
      memories: [
        { id: "m1", title: "Release train order" },
        { id: "m2", title: "Efficiency finding" },
      ],
      rules: [{ id: "r1", name: "Keep PRs small", scope_type: "project", priority: "high" }],
      skills: [
        { id: "s1", name: "pathrule-release", source: "manual" },
        { id: "s2", name: "pathrule-release-web", source: "manual" },
      ],
    },
    {
      node_id: "n-app",
      relative_path: "/packages/app",
      skills: [{ id: "s3", name: "pathrule-release", source: "manual" }],
      memories: [],
      rules: [],
    },
  ];
  const row = (id: string) =>
    ({ id, versionId: `ver-${id}`, updatedAt: "2026-07-02T00:00:00Z", content: `BODY_${id}` }) as never;
  const backend = {
    workspaceOverview: async () => overview,
    readSkill: async (id: string) => row(id),
    readMemory: async (id: string) => row(id),
    readRule: async (id: string) => row(id),
  };
  return { backend: backend as never, userId: "u1", workspaceId: "w1" };
}

describe("resolveHandler — name/title -> editing handle", () => {
  it("returns nothing to attach but lists both when a name is ambiguous across paths", async () => {
    const res = await resolveHandler(makeCtx(), { workspaceId: "w1", query: "pathrule-release", kind: "skill" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // "pathrule-release" exact-matches s1 and s3 (two paths) — plus a prefix hit on s2.
    const exact = res.data.matches.filter((m) => m.name === "pathrule-release");
    expect(exact.length).toBe(2);
    // Ambiguous: no version_id attached, unique=false.
    expect(res.data.unique).toBe(false);
    expect(exact.every((m) => m.version_id === undefined)).toBe(true);
  });

  it("disambiguates by node_path and attaches version_id for the lone exact hit", async () => {
    const res = await resolveHandler(makeCtx(), {
      workspaceId: "w1",
      query: "pathrule-release",
      kind: "skill",
      node_path: "/packages/app",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unique).toBe(true);
    const hit = res.data.matches.find((m) => m.id === "s3");
    expect(hit?.node_path).toBe("/packages/app");
    expect(hit?.version_id).toBe("ver-s3");
  });

  it("attaches version_id when there is a single unique exact match overall", async () => {
    const res = await resolveHandler(makeCtx(), { workspaceId: "w1", query: "Efficiency finding" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unique).toBe(true);
    expect(res.data.matches[0]?.id).toBe("m2");
    expect(res.data.matches[0]?.version_id).toBe("ver-m2");
    expect(res.data.matches[0]?.kind).toBe("memory");
  });

  it("kind filter restricts the search space", async () => {
    const res = await resolveHandler(makeCtx(), { workspaceId: "w1", query: "release", kind: "memory" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matches.every((m) => m.kind === "memory")).toBe(true);
  });

  it("attaches the full body for a unique winner (resolve+read in one call)", async () => {
    const res = await resolveHandler(makeCtx(), { workspaceId: "w1", query: "Efficiency finding" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matches[0]?.content).toBe("BODY_m2");
  });

  it("omits the body when include_body:false (handle only)", async () => {
    const res = await resolveHandler(makeCtx(), {
      workspaceId: "w1",
      query: "Efficiency finding",
      include_body: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matches[0]?.content).toBeUndefined();
    expect(res.data.matches[0]?.version_id).toBe("ver-m2"); // handle still present
  });

  it("rejects an empty query", async () => {
    const res = await resolveHandler(makeCtx(), { workspaceId: "w1", query: "  " });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_args");
  });
});
