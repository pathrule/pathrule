// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import type { WorkspaceOverviewNode } from "@pathrule/core/tools/overview.js";

import { activeFileTarget } from "../tree/active-file.js";
import { activityRow, relativeTime } from "../tree/activity-format.js";
import { buildKnowledgeTree, closestTreePath, groupContent, normalizePath } from "../tree/model.js";
import type { BoundFolder } from "../binding/types.js";

const overview = (entries: Array<Partial<WorkspaceOverviewNode>>): WorkspaceOverviewNode[] =>
  entries.map((e) => ({
    node_id: e.node_id ?? "n",
    relative_path: e.relative_path ?? "",
    memories: e.memories ?? [],
    rules: e.rules ?? [],
    skills: e.skills ?? [],
  }));

describe("buildKnowledgeTree", () => {
  const tree = buildKnowledgeTree(
    overview([
      {
        node_id: "root",
        relative_path: "",
        memories: [{ id: "m1", title: "Workspace conventions" }],
      },
      {
        node_id: "deep",
        relative_path: "/apps/web/checkout",
        rules: [{ id: "r1", name: "No inline styles", scope_type: "folder", priority: "high" }],
      },
      {
        node_id: "apps",
        relative_path: "/apps",
        skills: [{ id: "s1", name: "release-checklist", source: "github_ref" }],
      },
    ]),
  );

  it("materialises intermediate path segments", () => {
    expect([...tree.byPath.keys()].sort()).toEqual([
      "",
      "/apps",
      "/apps/web",
      "/apps/web/checkout",
    ]);
  });

  it("hangs content on the right paths with counts", () => {
    expect(tree.root.content[0]?.label).toBe("Workspace conventions");
    const checkout = tree.byPath.get("/apps/web/checkout");
    expect(checkout?.counts).toEqual({ memories: 0, rules: 1, skills: 0 });
    expect(checkout?.content[0]?.detail).toBe("high");
  });

  it("github_ref skills carry the linked marker", () => {
    expect(tree.byPath.get("/apps")?.content[0]?.detail).toBe("linked");
  });

  it("closestTreePath walks up to the deepest covering path", () => {
    expect(closestTreePath(tree, "/apps/web/checkout/components").path).toBe("/apps/web/checkout");
    expect(closestTreePath(tree, "/packages/unknown").path).toBe("");
  });

  it("normalizePath canonical forms", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("apps/web/")).toBe("/apps/web");
  });
});

describe("groupContent (owner revision — root content grouped by kind)", () => {
  it("groups in memory→rule→skill order, dropping empty kinds", () => {
    const tree = buildKnowledgeTree(
      overview([
        {
          node_id: "root",
          relative_path: "",
          memories: [
            { id: "m1", title: "A" },
            { id: "m2", title: "B" },
          ],
          skills: [{ id: "s1", name: "release", source: "manual" }],
        },
      ]),
    );
    const groups = groupContent(tree.root.content, "");
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Memories", 2],
      ["Skills", 1],
    ]);
    expect(groups.every((g) => g.nodePath === "")).toBe(true);
  });
});

describe("activeFileTarget", () => {
  const binding: BoundFolder = {
    kind: "local",
    backend: {} as BoundFolder["backend"],
    workspaceId: "ws",
    workspaceName: null,
    localRootPath: "/repo",
    relativePath: "",
  };
  const tree = buildKnowledgeTree(
    overview([{ node_id: "a", relative_path: "/apps", memories: [{ id: "m", title: "t" }] }]),
  );

  it("maps a file to its folder path and the covering tree node", () => {
    const target = activeFileTarget("/repo/apps/web/page.tsx", binding, tree);
    expect(target?.relativePath).toBe("/apps/web");
    expect(target?.treeNode?.path).toBe("/apps");
    expect(target?.countsSummary).toBe("1 memory");
  });

  it("files outside the workspace root are ignored", () => {
    expect(activeFileTarget("/elsewhere/x.ts", binding, tree)).toBeNull();
  });

  it("unbound folders produce no target", () => {
    expect(
      activeFileTarget(
        "/repo/x.ts",
        {
          kind: "unbound",
          mode: "cloud",
          reason: "signed-out",
          hasSession: false,
          localAvailable: true,
        },
        tree,
      ),
    ).toBeNull();
  });
});

describe("activity formatting", () => {
  it("summary + relative time + path", () => {
    const row = activityRow(
      {
        id: "1",
        nodePath: "/apps/web",
        domain: "ui",
        action: "update",
        taskSummary: "Tightened the checkout flow",
        createdAt: new Date(1_000_000).toISOString(),
      },
      1_000_000 + 90 * 60_000,
    );
    expect(row.label).toBe("Tightened the checkout flow");
    expect(row.description).toBe("2h ago · /apps/web");
    expect(row.tooltip).toBe("ui/update");
  });

  it("relativeTime buckets", () => {
    expect(relativeTime(0, 30_000)).toBe("just now");
    expect(relativeTime(0, 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(0, 3 * 86_400_000)).toBe("3d ago");
  });
});
