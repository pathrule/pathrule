// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_SEARCH_ALL_LIMIT_MAX,
  KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX,
  type KnowledgeListItem,
} from "@pathrule/protocol/local-ui-api.js";
import { InMemoryKnowledgeBackend } from "../backend/in-memory-backend.js";
import { LocalBackend } from "../backend/local/local-backend.js";
import {
  knowledgeSearchContract,
  type SearchContractConsole,
} from "../backend/contract-suite-search.js";
import {
  inFolder,
  parseKnowledgeSearch,
  prefilterTerms,
  rankKnowledge,
} from "./knowledge-query.js";
import { searchAllWorkspaces } from "./search-all-route.js";
import { createWorkspaceRoutes, type WorkspaceRouteStore } from "./workspace-routes.js";

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message: string) => new ApiError("bad_request", message);

/** Local's console over one store: the shared routes, and `knowledge.searchAll` over its workspaces. */
function localConsole(store: WorkspaceRouteStore): SearchContractConsole {
  const workspaces: SearchContractConsole["workspaces"] = [
    { id: "ws-search-a", name: "Alpha" },
    { id: "ws-search-b", name: "Beta" },
  ];
  const routes = createWorkspaceRoutes({
    workspace: async (value) => {
      const found = workspaces.find((w) => w.id === value);
      if (!found) throw new ApiError("not_found", "No local workspace has this id.");
      return found;
    },
    store: async () => store,
    written: async (_target, id, versionId) => ({ id, versionId, hookIndex: "synced" }),
    errors: {
      bad,
      notFound: (message) => new ApiError("not_found", message),
      conflict: (message) => new ApiError("conflict", message),
    },
  });
  return {
    workspaces,
    call: async <T>(route: string, body: Record<string, unknown>) =>
      (route === "knowledge.searchAll"
        ? await searchAllWorkspaces(body, { workspaces, store: async () => store, bad })
        : await routes[route as keyof typeof routes](body)) as T,
    code: (err) => (err instanceof ApiError ? err.code : "internal"),
  };
}

knowledgeSearchContract("InMemoryKnowledgeBackend", async () =>
  localConsole(new InMemoryKnowledgeBackend()),
);
knowledgeSearchContract("LocalBackend (sqlite :memory:)", async () =>
  localConsole(new LocalBackend(":memory:")),
);

function item(overrides: Partial<KnowledgeListItem>): KnowledgeListItem {
  return {
    id: "m-1",
    kind: "memory",
    title: "Title",
    preview: "",
    path: "/",
    updatedAt: "2026-10-01T00:00:00.000Z",
    versionNumber: 1,
    ...overrides,
  };
}

describe("a search's folder", () => {
  it("holds an item by any of its paths, at the folder or below, never beside it", () => {
    const rule = item({ kind: "rule", path: "/a", paths: ["/a", "/b/c"] });
    expect(inFolder(rule, "/b")).toBe(true);
    expect(inFolder(rule, "/b/c")).toBe(true);
    expect(inFolder(rule, "/b/c/d")).toBe(false);
    expect(inFolder(rule, "/a/b")).toBe(false);
    expect(inFolder(item({ path: "/apiary", paths: ["/apiary"] }), "/api")).toBe(false);
    // An item attached nowhere is only in "/", which holds everything.
    expect(inFolder(item({ path: null, paths: [] }), "/")).toBe(true);
    expect(inFolder(item({ path: null, paths: [] }), "/a")).toBe(false);
  });

  it("is validated and normalized; a limit stays between 1 and the route's most", () => {
    expect(parseKnowledgeSearch({ query: " Retry ", path: "//apps//api/" }, bad, 100)).toEqual({
      needle: "retry",
      folder: "/apps/api",
      kinds: ["memory", "rule", "skill"],
      limit: 20,
    });
    const limit = (value: number) =>
      parseKnowledgeSearch({ query: "x", limit: value }, bad, KNOWLEDGE_SEARCH_ALL_LIMIT_MAX).limit;
    expect([limit(1), limit(50), limit(51), limit(500), limit(-3)]).toEqual([1, 50, 50, 50, 1]);
    expect(() => parseKnowledgeSearch({ query: "", path: "/" }, bad, 100)).not.toThrow();
    expect(() => parseKnowledgeSearch({ query: "x".repeat(501) }, bad, 100)).toThrow(/longer/);
  });

  it("ranks a folder listing by path, then title, case-insensitively", () => {
    const ranked = rankKnowledge(
      [
        item({ id: "3", path: "/b", title: "alpha" }),
        item({ id: "2", path: "/a", title: "beta" }),
        item({ id: "1", path: "/a", title: "Alpha" }),
      ],
      { needle: "", folder: "/" },
    );
    expect(ranked.map((r) => [r.id, r.score])).toEqual([
      ["1", 1],
      ["2", 1],
      ["3", 1],
    ]);
  });
});

/** SQLite's lower() after the two mappings a store applies (the knowledge search of Pathrule Cloud). */
function storeLower(text: string): string {
  return text
    .replaceAll("İ", "i̇")
    .replaceAll("K", "k")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

describe("prefilterTerms", () => {
  it("keeps the words a case-blind ASCII lower() can find, longest first", () => {
    expect(prefilterTerms("retry policy")).toEqual(["policy", "retry"]);
    expect(prefilterTerms("Straße")).toEqual(["stra", "e"]);
    expect(prefilterTerms("çay saati")).toEqual(["saati", "ay"]);
    expect(prefilterTerms("日本語 api")).toEqual(["日本語", "api"]);
    expect(prefilterTerms("ÇĞÜ")).toEqual([]);
    expect(prefilterTerms("")).toEqual([]);
    expect(prefilterTerms("a b c d e f g h i j")).toHaveLength(8);
  });

  it("never leaves out an item the score would find (every term is in the store's lower case)", () => {
    const texts = [
      "İstanbul ofisi ÇALIŞIR",
      "Die STRASSE und die Straße",
      "KELVIN K scale",
      "Retries use JITTER on every call",
      "日本語のドキュメント API",
      "Ünïcödé ÉLAN façade",
    ];
    for (const text of texts) {
      const lower = text.toLowerCase();
      // Every substring of the text a person could type is a needle that finds it.
      for (let start = 0; start < lower.length; start++) {
        for (let end = start + 1; end <= Math.min(lower.length, start + 12); end++) {
          const needle = lower.slice(start, end).trim();
          if (!needle || !lower.includes(needle)) continue;
          for (const term of prefilterTerms(needle)) {
            expect(storeLower(text).includes(term), `${needle} → ${term} in ${text}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("knowledge.searchAll over a home", () => {
  const readable = new InMemoryKnowledgeBackend();

  it("searches the first 50 workspaces and says it left the rest out", async () => {
    const store = new InMemoryKnowledgeBackend();
    const workspaces = Array.from({ length: KNOWLEDGE_SEARCH_ALL_WORKSPACES_MAX + 1 }, (_, i) => ({
      id: `ws-${String(i).padStart(2, "0")}`,
      name: `Workspace ${i}`,
    }));
    for (const workspace of workspaces) {
      await store.writeMemory({ workspaceId: workspace.id, title: "Retry", content: "Jitter." });
    }
    const answer = await searchAllWorkspaces(
      { query: "retry", limit: 50 },
      { workspaces, store: async () => store, bad },
    );
    expect(answer.truncated).toBe(true);
    expect(answer.items).toHaveLength(50);
    expect(answer.items.some((i) => i.workspaceId === "ws-50")).toBe(false);
    const fits = await searchAllWorkspaces(
      { query: "retry" },
      { workspaces: workspaces.slice(0, 50), store: async () => store, bad },
    );
    expect([fits.items.length, fits.truncated]).toEqual([20, false]);
  });

  it("leaves out a workspace it cannot read and says so; with none readable it fails", async () => {
    await readable.writeMemory({ workspaceId: "ok", title: "Retry", content: "Jitter." });
    const workspaces = [
      { id: "ok", name: "Readable" },
      { id: "broken", name: "Unreadable" },
    ];
    const store = async (id: string) => {
      if (id === "broken") throw new Error("store could not be opened");
      return readable;
    };
    const answer = await searchAllWorkspaces({ query: "retry" }, { workspaces, store, bad });
    expect([answer.items.map((i) => i.workspaceName), answer.truncated]).toEqual([
      ["Readable"],
      true,
    ]);
    await expect(
      searchAllWorkspaces({ query: "retry" }, { workspaces: [workspaces[1]!], store, bad }),
    ).rejects.toThrow("store could not be opened");
    expect(await searchAllWorkspaces({ query: "retry" }, { workspaces: [], store, bad })).toEqual({
      items: [],
      truncated: false,
    });
  });
});
