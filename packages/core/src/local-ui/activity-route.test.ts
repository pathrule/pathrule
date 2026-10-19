// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { InMemoryKnowledgeBackend } from "../backend/in-memory-backend.js";
import type { Activity, LogActivityInput } from "../backend/inputs.js";
import { activityFiles } from "./activity-route.js";
import {
  createWorkspaceRoutes,
  type WorkspaceRouteStore,
  type WorkspaceRouteTarget,
} from "./workspace-routes.js";

const DAY = 86_400_000;

class BadRequest extends Error {}

function routes(
  store: unknown,
  target: WorkspaceRouteTarget = { id: "ws" },
  people?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
) {
  return createWorkspaceRoutes({
    workspace: async (value) => {
      if (value !== target.id) throw new Error("not this workspace");
      return target;
    },
    store: async () => store as WorkspaceRouteStore,
    written: async () => {
      throw new Error("no writes here");
    },
    errors: {
      bad: (message) => new BadRequest(message),
      notFound: (message) => new Error(message),
      conflict: (message) => new Error(message),
    },
    ...(people ? { people } : {}),
  })["activity.recent"];
}

/** An in-memory store whose entries were logged `ages` days ago, newest last. */
async function storeWithAges(ages: number[], extra: Partial<LogActivityInput> = {}) {
  let at = Date.now();
  const store = new InMemoryKnowledgeBackend({ now: () => new Date(at).toISOString() });
  for (const age of ages) {
    at = Date.now() - age * DAY;
    await store.logActivity({
      workspaceId: "ws",
      nodePath: "/src/api",
      domain: "backend",
      action: "fix",
      scope: "api",
      taskSummary: `${age} days ago`,
      ...extra,
    });
  }
  return store;
}

interface Answer {
  entries: Array<Record<string, unknown> & { summary: string; files: string[] }>;
  truncated: boolean;
}

describe("activity.recent", () => {
  it("answers the entries of a 7, 30 or 90 day window, newest first", async () => {
    const recent = routes(await storeWithAges([100, 40, 10, 2]));
    const summaries = async (body: Record<string, unknown>) =>
      ((await recent({ workspaceId: "ws", ...body })) as Answer).entries.map((e) => e.summary);
    expect(await summaries({ days: 7 })).toEqual(["2 days ago"]);
    expect(await summaries({ days: 30 })).toEqual(["2 days ago", "10 days ago"]);
    expect(await summaries({ days: 90 })).toEqual(["2 days ago", "10 days ago", "40 days ago"]);
    expect(await summaries({})).toEqual([
      "2 days ago",
      "10 days ago",
      "40 days ago",
      "100 days ago",
    ]);
  });

  it("refuses any other window and fields it does not take", async () => {
    const recent = routes(await storeWithAges([1]));
    for (const days of [14, 0, "7", null, 7.5]) {
      await expect(recent({ workspaceId: "ws", days }), String(days)).rejects.toBeInstanceOf(
        BadRequest,
      );
    }
    await expect(recent({ workspaceId: "ws", since: "2026-01-01" })).rejects.toThrow(
      'Unknown field "since".',
    );
    await expect(recent({ workspaceId: "ws", limit: "5" })).rejects.toBeInstanceOf(BadRequest);
  });

  it("says when the window holds more than the limit", async () => {
    const recent = routes(await storeWithAges([5, 4, 3, 2, 1]));
    const three = (await recent({ workspaceId: "ws", days: 7, limit: 3 })) as Answer;
    expect(three.entries.map((e) => e.summary)).toEqual(["1 days ago", "2 days ago", "3 days ago"]);
    expect(three.truncated).toBe(true);
    const all = (await recent({ workspaceId: "ws", days: 7, limit: 5 })) as Answer;
    expect(all.entries).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });

  it("reads one more than the limit: 30 and at most 200, or 500 and at most 1,000 in a window", async () => {
    const store = { recentActivities: vi.fn(async (): Promise<Activity[]> => []) };
    const recent = routes(store);
    const asked = async (body: Record<string, unknown>) => {
      await recent({ workspaceId: "ws", ...body });
      const call = store.recentActivities.mock.calls.at(-1) as unknown[];
      return { limit: call[1], options: call[2] };
    };
    expect(await asked({})).toEqual({ limit: 31, options: undefined });
    expect(await asked({ limit: 5_000 })).toEqual({ limit: 201, options: undefined });
    expect(await asked({ limit: -3 })).toEqual({ limit: 2, options: undefined });
    const windowed = await asked({ days: 30 });
    expect(windowed.limit).toBe(501);
    const since = Date.parse((windowed.options as { since: string }).since);
    expect(Math.abs(since - (Date.now() - 30 * DAY))).toBeLessThan(60_000);
    expect((await asked({ days: 90, limit: 5_000 })).limit).toBe(1_001);
  });

  it("keeps the window when a store answers older entries anyway", async () => {
    const old = (age: number): Activity => ({
      id: `a-${age}`,
      nodePath: "/",
      domain: null,
      action: null,
      taskSummary: `${age}`,
      createdAt: new Date(Date.now() - age * DAY).toISOString(),
    });
    // A host older than `since` reads the newest entries whatever their age.
    const recent = routes({ recentActivities: async () => [old(1), old(20), old(50)] });
    const answer = (await recent({ workspaceId: "ws", days: 30, limit: 2 })) as Answer;
    expect(answer.entries.map((e) => e.summary)).toEqual(["1", "20"]);
    expect(answer.truncated).toBe(false);
  });

  it("carries the scope, subjects, files and client an entry was logged with; Local names no one", async () => {
    const recent = routes(
      await storeWithAges([1], {
        scope: "service",
        subjects: ["Auth", "auth ", "Tokens"],
        filesTouched: {
          total: 3,
          by_area: { api: ["./src/api/token.ts", "src/api/token.ts"], ui: ["/packages/ui/x.ts"] },
        },
        aiClient: "codex",
      }),
    );
    const { entries } = (await recent({ workspaceId: "ws", days: 7 })) as Answer;
    expect(entries[0]).toMatchObject({
      nodePath: "/src/api",
      domain: "backend",
      action: "fix",
      scope: "service",
      subjects: ["auth", "tokens"],
      files: ["src/api/token.ts", "packages/ui/x.ts"],
      client: "codex",
      person: null,
    });
  });

  it("makes files under a Local workspace's folder relative and shows no other absolute path", async () => {
    const recent = routes(
      await storeWithAges([1], {
        filesTouched: {
          total: 4,
          by_area: {
            api: ["/Users/me/repo/src/a.ts", "/Users/me/elsewhere/b.ts", "~/notes.md", "src/c.ts"],
          },
        },
      }),
      { id: "ws", rootPath: "/Users/me/repo" },
    );
    const { entries } = (await recent({ workspaceId: "ws" })) as Answer;
    expect(entries[0]!.files).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("names the account each entry was logged for, where the backend has accounts", async () => {
    const row = (id: string, actorId: string | null): Activity => ({
      id,
      nodePath: "/",
      domain: null,
      action: null,
      taskSummary: id,
      createdAt: new Date().toISOString(),
      actorId,
    });
    const store = {
      recentActivities: async () => [row("a", "u-1"), row("b", "u-2"), row("c", null)],
    };
    const people = vi.fn(async () => new Map([["u-1", "Ada"]]));
    const { entries } = (await routes(
      store,
      { id: "ws" },
      people,
    )({ workspaceId: "ws" })) as Answer;
    expect(entries.map((e) => e.person)).toEqual([
      { id: "u-1", name: "Ada" },
      { id: "u-2", name: "u-2" },
      null,
    ]);
    expect(people).toHaveBeenCalledOnce();
    expect(people).toHaveBeenCalledWith(["u-1", "u-2"]);
    const unnamed = (await routes(store)({ workspaceId: "ws" })) as Answer;
    expect(unnamed.entries[0]!.person).toEqual({ id: "u-1", name: "u-1" });
  });
});

describe("activity files", () => {
  it("flatten what files_touched holds, without ./, once each, at most 50", () => {
    expect(
      activityFiles({ total: 3, by_area: { api: ["./a.ts", "a.ts"], db: ["b.sql"] } }, null),
    ).toEqual(["a.ts", "b.sql"]);
    expect(activityFiles(["a.ts", "dir//b.ts/", "./dir/./c.ts"], null)).toEqual([
      "a.ts",
      "dir/b.ts",
      "dir/c.ts",
    ]);
    expect(activityFiles('{"by_area":{"api":["a.ts"]},"total":1}', null)).toEqual(["a.ts"]);
    expect(activityFiles('["a.ts"]', null)).toEqual(["a.ts"]);
    expect(
      activityFiles({ created: ["a.ts"], modified: [{ path: "b.ts" }], note: "x" }, null),
    ).toEqual(["a.ts", "b.ts"]);
    for (const nothing of [undefined, null, 7, "", "{broken", { total: 0, by_area: {} }, []]) {
      expect(activityFiles(nothing, null), JSON.stringify(nothing)).toEqual([]);
    }
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    expect(activityFiles({ by_area: { a: many, b: ["f0.ts"] } }, null)).toEqual(many.slice(0, 50));
  });

  it("are relative to the Local workspace's folder, and no other absolute path is shown", () => {
    const root = "/Users/me/repo";
    const shown = (path: string) => activityFiles([path], root)[0] ?? null;
    expect(shown("/Users/me/repo/src/a.ts")).toBe("src/a.ts");
    // macOS and Windows compare folders case-insensitively.
    expect(shown("/users/ME/repo/src/a.ts")).toBe("src/a.ts");
    // A writer that knew no root stripped the "/".
    expect(shown("Users/me/repo/src/a.ts")).toBe("src/a.ts");
    // An agent's workspace-relative path with a leading "/".
    expect(shown("/packages/ui/x.ts")).toBe("packages/ui/x.ts");
    for (const outside of [
      "/Users/me/repo",
      "/Users/me/other/a.ts",
      "Users/me/other/a.ts",
      "/tmp/scratch.ts",
      "/private/var/folders/x.ts",
      "/home/me/a.ts",
      "~/notes.md",
      "~",
      "../sibling/a.ts",
      "src/../../a.ts",
      "C:\\Users\\me\\a.ts",
      "c:/x.ts",
      "//server/share/a.ts",
      "file:///Users/me/repo/a.ts",
      "src/a\u0000.ts",
      "/",
      ".",
    ]) {
      expect(shown(outside), outside).toBeNull();
    }
  });

  it("know a Windows folder, and a root inside a project folder name", () => {
    const windows = "C:\\Users\\me\\repo";
    expect(
      activityFiles(["C:\\Users\\me\\repo\\src\\a.ts", "c:/users/me/repo/b.ts"], windows),
    ).toEqual(["src/a.ts", "b.ts"]);
    expect(activityFiles(["D:/other/x.ts", "C:/Users/me/x.ts"], windows)).toEqual([]);
    // A container's /app root: the project's own app/ folder stays what it is.
    expect(
      activityFiles(["app/page.tsx", "/app/src/x.ts", "/app", "/apps/web/y.ts"], "/app"),
    ).toEqual(["app/page.tsx", "src/x.ts", "apps/web/y.ts"]);
    // A sibling of the workspace, by the root's first folder.
    expect(activityFiles(["/work/other/a.ts", "/work/proj/b.ts"], "/work/proj")).toEqual(["b.ts"]);
  });

  it("keep workspace-relative paths where the root is unknown (Cloud) and drop homes", () => {
    expect(
      activityFiles(
        [
          "/packages/ui/x.ts",
          "home/models.py",
          "app/page.tsx",
          "/Users/me/repo/a.ts",
          "Users/me/repo/a.ts",
          "/home/runner/work/a.ts",
          "/etc/passwd",
          "/Volumes/disk/a.ts",
        ],
        null,
      ),
    ).toEqual(["packages/ui/x.ts", "home/models.py", "app/page.tsx"]);
  });
});
