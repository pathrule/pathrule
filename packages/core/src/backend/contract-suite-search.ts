// SPDX-License-Identifier: Apache-2.0
// The Local UI API's knowledge search as every backend answers it: `knowledge.search` kept to a folder
// (`path`), a folder listed with an empty query, and `knowledge.searchAll` over two workspaces. Each
// backend is reached the way its console reaches it (Local through the shared routes over its store,
// Pathrule Cloud through its Worker), so the cases hold both to one contract. Registered by each
// backend's own test file (packages/core/src/local-ui/search-route.test.ts, Pathrule Cloud's
// test/knowledge-search.test.ts).
import { describe, expect, it } from "vitest";

/** A console of one backend, over two fresh workspaces the person reads. */
export interface SearchContractConsole {
  /** Empty workspaces; the first one's name sorts before the second's. */
  workspaces: [{ id: string; name: string }, { id: string; name: string }];
  /** A Local UI API route; a workspace's route names it in `workspaceId`, as the console does. */
  call<T = unknown>(route: string, body: Record<string, unknown>): Promise<T>;
  /** The Local UI API error code a refused call answered with: "bad_request", "not_found" … */
  code(err: unknown): string;
}

interface Found {
  id: string;
  kind: string;
  title: string;
  path: string | null;
  score: number;
  workspaceId?: string;
  workspaceName?: string;
}

export function knowledgeSearchContract(
  label: string,
  open: () => Promise<SearchContractConsole>,
): void {
  /** Seven items, one archived: a memory, a rule and a skill under /apps, one at the root, one beside. */
  async function seeded() {
    const api = await open();
    const [a, b] = api.workspaces;
    const create = async (
      workspaceId: string,
      kind: string,
      path: string,
      title: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) =>
      (
        await api.call<{ id: string }>("knowledge.create", {
          workspaceId,
          kind,
          path,
          title,
          content,
          ...extra,
        })
      ).id;
    const ids = {
      retry: await create(a.id, "memory", "/apps/api", "Retry policy", "Retries use jitter."),
      client: await create(a.id, "rule", "/apps/api/src", "Use the client", "Never fetch.", {
        priority: "high",
        scopeType: "folder",
      }),
      release: await create(
        a.id,
        "skill",
        "/apps/web",
        "Release the web app",
        "Ship after the retry checks.",
      ),
      // Beside /apps/api, not in it: a folder holds what is under it, not what starts like it.
      apiary: await create(a.id, "memory", "/apps/apiary", "Bees", "Retry beekeeping in spring."),
      team: await create(a.id, "memory", "/", "Team conventions", "Write retries down."),
      archived: await create(a.id, "memory", "/apps/api", "Retired retry note", "Archived."),
      budget: await create(
        b.id,
        "memory",
        "/apps/api",
        "Retry budget",
        "Retries stop after three.",
      ),
    };
    await api.call("knowledge.delete", { workspaceId: a.id, kind: "memory", id: ids.archived });
    const search = (workspaceId: string, body: Record<string, unknown>) =>
      api.call<{ items: Found[] }>("knowledge.search", { workspaceId, ...body });
    const searchAll = (body: Record<string, unknown>) =>
      api.call<{ items: Found[]; truncated: boolean }>("knowledge.searchAll", body);
    const refused = async (call: Promise<unknown>) => {
      try {
        await call;
      } catch (err) {
        return api.code(err);
      }
      throw new Error("expected a refusal");
    };
    return { a, b, ids, search, searchAll, refused };
  }

  const idsOf = (found: { items: Found[] }) => found.items.map((item) => item.id);
  const scoresDescend = (items: Found[]) =>
    items.every((item, index) => index === 0 || items[index - 1]!.score >= item.score);

  describe(`Local UI API knowledge search — ${label}`, () => {
    it("keeps knowledge.search to a folder, by any path at it or below", async () => {
      const { a, ids, search } = await seeded();
      const everywhere = await search(a.id, { query: "retr" });
      expect(new Set(idsOf(everywhere))).toEqual(
        new Set([ids.retry, ids.release, ids.apiary, ids.team]),
      );
      expect(everywhere.items[0]).toMatchObject({ id: ids.retry, score: 40 });
      expect(scoresDescend(everywhere.items)).toBe(true);
      // "/" is every item, and a folder is normalized.
      expect(new Set(idsOf(await search(a.id, { query: "retr", path: "/" })))).toEqual(
        new Set(idsOf(everywhere)),
      );
      expect(idsOf(await search(a.id, { query: "retr", path: "/apps/api" }))).toEqual([ids.retry]);
      expect(idsOf(await search(a.id, { query: "retr", path: "/apps/api/" }))).toEqual([ids.retry]);
      expect(new Set(idsOf(await search(a.id, { query: "RETR", path: "/apps" })))).toEqual(
        new Set([ids.retry, ids.release, ids.apiary]),
      );
      expect(idsOf(await search(a.id, { query: "retr", path: "/elsewhere" }))).toEqual([]);
      // A folder's own path counts toward the score as before.
      expect(await search(a.id, { query: "apps/api/src", path: "/apps" })).toMatchObject({
        items: [{ id: ids.client, kind: "rule", path: "/apps/api/src", score: 15 }],
      });
    });

    it("lists a folder for an empty query: every active item, by path then title, score 1", async () => {
      const { a, ids, search } = await seeded();
      const listed = await search(a.id, { query: "", path: "/apps" });
      expect(listed.items.map((item) => [item.path, item.title, item.score])).toEqual([
        ["/apps/api", "Retry policy", 1],
        ["/apps/api/src", "Use the client", 1],
        ["/apps/apiary", "Bees", 1],
        ["/apps/web", "Release the web app", 1],
      ]);
      // Blank is empty; the archived item is never listed.
      expect(idsOf(await search(a.id, { query: "  ", path: "/apps/api" }))).toEqual([
        ids.retry,
        ids.client,
      ]);
      expect(idsOf(await search(a.id, { query: "", path: "/", kinds: ["rule"] }))).toEqual([
        ids.client,
      ]);
      expect(idsOf(await search(a.id, { query: "", path: "/", limit: 2 }))).toEqual([
        ids.team,
        ids.retry,
      ]);
    });

    it("refuses an empty query without a folder and a folder that is not one", async () => {
      const { a, search, refused } = await seeded();
      expect(await refused(search(a.id, { query: "" }))).toBe("bad_request");
      expect(await refused(search(a.id, { query: " " }))).toBe("bad_request");
      for (const path of ["apps", "/apps/../etc", "/apps\\api", `/${"a".repeat(512)}`, 7, ""]) {
        expect(await refused(search(a.id, { query: "retr", path })), String(path)).toBe(
          "bad_request",
        );
      }
      // At most 512 characters is a folder, even one that holds nothing.
      expect((await search(a.id, { query: "retr", path: `/${"a".repeat(511)}` })).items).toEqual(
        [],
      );
    });

    it("searches every workspace at once, each item scored as its own workspace's search scores it", async () => {
      const { a, b, ids, search, searchAll } = await seeded();
      const found = await searchAll({ query: "retr" });
      expect(found.truncated).toBe(false);
      expect(new Set(idsOf(found))).toEqual(
        new Set([ids.retry, ids.release, ids.apiary, ids.team, ids.budget]),
      );
      expect(scoresDescend(found.items)).toBe(true);
      for (const workspace of [a, b]) {
        const own = await search(workspace.id, { query: "retr" });
        const mine = found.items.filter((item) => item.workspaceId === workspace.id);
        expect(mine.map((item) => [item.id, item.score]).sort()).toEqual(
          own.items.map((item) => [item.id, item.score]).sort(),
        );
        expect(mine.every((item) => item.workspaceName === workspace.name)).toBe(true);
      }
      expect(found.items.slice(0, 2).map((item) => item.score)).toEqual([40, 40]);
      expect(idsOf(await searchAll({ query: "retr", limit: 1 }))).toHaveLength(1);
      expect(idsOf(await searchAll({ query: "retr", kinds: ["skill"] }))).toEqual([ids.release]);
      expect(new Set(idsOf(await searchAll({ query: "retr", path: "/apps/api" })))).toEqual(
        new Set([ids.retry, ids.budget]),
      );
    });

    it("lists a folder across workspaces for an empty query, by path, title, then workspace", async () => {
      const { a, b, ids, searchAll } = await seeded();
      const listed = await searchAll({ query: "", path: "/apps/api" });
      expect(listed).toEqual({
        truncated: false,
        items: [
          expect.objectContaining({
            id: ids.budget,
            workspaceId: b.id,
            workspaceName: b.name,
            score: 1,
          }),
          expect.objectContaining({
            id: ids.retry,
            workspaceId: a.id,
            workspaceName: a.name,
            score: 1,
          }),
          expect.objectContaining({ id: ids.client, workspaceId: a.id, score: 1 }),
        ],
      });
      // A limit past the most is the most, never a refusal.
      expect(idsOf(await searchAll({ query: "", path: "/", limit: 80 }))).toHaveLength(6);
    });

    it("refuses what knowledge.searchAll does not take", async () => {
      const { a, searchAll, refused } = await seeded();
      for (const body of [
        {},
        { query: "" },
        { query: 7 },
        { query: "retr", workspaceId: a.id },
        { query: "retr", path: "apps" },
        { query: "retr", kinds: [] },
        { query: "retr", kinds: ["note"] },
        { query: "retr", limit: 2.5 },
      ]) {
        expect(await refused(searchAll(body)), JSON.stringify(body)).toBe("bad_request");
      }
    });
  });
}
